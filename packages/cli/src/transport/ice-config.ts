/**
 * ICE server lifetime manager for host and attach sessions.
 *
 * The relay includes `iceExpiresAt` in `welcome`/`ice`. This manager refreshes
 * shortly before expiry, serializes refresh requests (the wire protocol has no
 * request id), and exposes a bounded `refreshForRetry()` used once by the P2P
 * failure path.
 */

import type {
  IceProvider,
  IceServerConfig,
  KnownControlMessage,
  WelcomeMessage,
} from "@limccn/tokimeki-protocol";

import type { Logger } from "../logger.js";
import type { RelayConnectionState } from "./relay-types.js";

export const ICE_REFRESH_TIMEOUT_MS = 8_000;
export const ICE_REFRESH_QUIET_MS = 2_000;
export const P2P_RETRY_REFRESH_BUDGET_MS = 20_000;
export const ICE_EXPIRY_RETRY_WINDOW_MS = 300_000;
export const ICE_RETRY_INITIAL_MS = 30_000;
export const ICE_RETRY_MAX_MS = 300_000;

export interface IceConfig {
  readonly servers: readonly IceServerConfig[];
  readonly provider: IceProvider;
  readonly expiresAt: number | null;
  readonly generation: number;
}

export interface IceConfigTimers {
  setTimeout(handler: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

export interface IceConfigManagerOptions {
  readonly logger: Logger;
  readonly sendIceRefresh: (provider?: IceProvider) => void;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly timers?: IceConfigTimers;
}

type IceMessage = Extract<KnownControlMessage, { type: "ice" }>;

interface PendingRefresh {
  readonly requestedProvider: IceProvider | undefined;
  readonly resolve: (config: IceConfig) => void;
  readonly reject: (error: Error) => void;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  readonly timer: NodeJS.Timeout;
}

const RETRY_PROVIDER_ORDER = ["coturn", "static", "cloudflare"] as const;

const defaultTimers: IceConfigTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

function urlsOf(server: IceServerConfig): string[] {
  return typeof server.urls === "string" ? [server.urls] : server.urls;
}

/** True when the ICE server list contains a TURN URL. */
export function hasTurnServer(servers: readonly IceServerConfig[]): boolean {
  return servers.some((server) => urlsOf(server).some((url) => /^turns?:/i.test(url)));
}

/** Providers after the failed one, in the roadmap's fixed order. */
export function nextRetryProviders(provider: IceProvider): IceProvider[] {
  const index = RETRY_PROVIDER_ORDER.indexOf(provider as (typeof RETRY_PROVIDER_ORDER)[number]);
  return index < 0 ? [] : RETRY_PROVIDER_ORDER.slice(index + 1);
}

export class IceConfigManager {
  readonly #options: IceConfigManagerOptions;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #timers: IceConfigTimers;
  readonly #updateHandlers = new Set<(config: IceConfig) => void>();

  #config: IceConfig = {
    servers: [],
    provider: "stun",
    expiresAt: null,
    generation: 0,
  };
  #relayState: RelayConnectionState = "closed";
  #refreshTimer: NodeJS.Timeout | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #retryDelayMs = ICE_RETRY_INITIAL_MS;
  #pending: PendingRefresh | null = null;
  #quietUntil = 0;
  #disposed = false;

  constructor(options: IceConfigManagerOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#timers = options.timers ?? defaultTimers;
  }

  get current(): IceConfig {
    return this.#config;
  }

  onUpdate(handler: (config: IceConfig) => void): () => void {
    this.#updateHandlers.add(handler);
    return () => this.#updateHandlers.delete(handler);
  }

  onRelayState(state: RelayConnectionState): void {
    this.#relayState = state;
    if (state === "ready") {
      this.#schedule();
      return;
    }
    this.#clearTimers();
    this.#settlePending(null, new Error("relay_not_ready"));
  }

  updateFromWelcome(welcome: WelcomeMessage): void {
    this.#setConfig(welcome.iceServers, welcome.iceProvider, welcome.iceExpiresAt ?? null);
  }

  updateFromIce(message: IceMessage): void {
    const config = this.#setConfig(
      message.iceServers,
      message.iceProvider,
      message.iceExpiresAt ?? null,
    );
    // Resolve even on a provider mismatch: refreshForRetry checks the actual
    // provider and continues to the next candidate.
    this.#settlePending(config);
  }

  /**
   * Request fresh ICE servers. Strictly serialized: a second caller waits for
   * the active request to settle, then sends its own request. Different
   * providers never share one promise.
   */
  async refresh(provider?: IceProvider): Promise<IceConfig> {
    // Re-check the pending request after every wait: multiple callers can be
    // waiting on the same `done` promise, and the first one to wake starts a
    // new request. Without the loop, a later waiter would overwrite that
    // request and leave the first caller's promise pending forever.
    for (;;) {
      if (this.#disposed || this.#relayState !== "ready") {
        throw new Error("relay_not_ready");
      }
      const quietRemaining = this.#quietUntil - this.#now();
      if (quietRemaining > 0) {
        await this.#sleep(quietRemaining);
        continue;
      }
      const pending = this.#pending;
      if (pending !== null) {
        await pending.done;
        continue;
      }
      // No await between the null check and `#startRefresh`, so concurrent
      // callers serialize instead of replacing the active request.
      return this.#startRefresh(provider);
    }
  }

  /**
   * Bounded provider refresh used by the one-shot P2P retry.
   *
   * Returns a usable TURN configuration, or null when the budget/providers are
   * exhausted. A concurrent successful refresh of the current config is reused.
   */
  async refreshForRetry(): Promise<IceConfig | null> {
    const deadline = this.#now() + P2P_RETRY_REFRESH_BUDGET_MS;
    const initialGeneration = this.#config.generation;

    if (this.#pending !== null) {
      try {
        await this.#waitWithin(this.#pending.done, deadline);
      } catch {
        return null;
      }
    }
    if (this.#config.generation > initialGeneration && hasTurnServer(this.#config.servers)) {
      return this.#config;
    }

    const failedProvider = this.#config.provider;
    if (failedProvider === "stun") {
      try {
        const config = await this.#refreshWithin(deadline);
        return hasTurnServer(config.servers) ? config : null;
      } catch {
        return null;
      }
    }

    if (this.#config.expiresAt !== null && this.#now() >= this.#config.expiresAt - 60_000) {
      try {
        const config = await this.#refreshWithin(deadline);
        if (hasTurnServer(config.servers)) return config;
      } catch {
        // Fall through to the provider candidates.
      }
    }

    for (const candidate of nextRetryProviders(failedProvider)) {
      if (this.#now() >= deadline) return null;
      try {
        const config = await this.#refreshWithin(deadline, candidate);
        if (config.provider === candidate && hasTurnServer(config.servers)) {
          return config;
        }
      } catch {
        // Try the next candidate until the budget is exhausted.
      }
    }
    return null;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearTimers();
    this.#settlePending(null, new Error("ice_config_disposed"));
    this.#updateHandlers.clear();
  }

  #setConfig(
    servers: readonly IceServerConfig[],
    provider: IceProvider,
    expiresAt: number | null,
  ): IceConfig {
    this.#config = {
      servers: [...servers],
      provider,
      expiresAt,
      generation: this.#config.generation + 1,
    };
    this.#retryDelayMs = ICE_RETRY_INITIAL_MS;
    this.#logger.debug(
      `ice config updated (provider=${provider}, ` +
        `expiresIn=${expiresAt === null ? "none" : `${Math.max(0, expiresAt - this.#now())}ms`})`,
    );
    for (const handler of this.#updateHandlers) handler(this.#config);
    this.#schedule();
    return this.#config;
  }

  #schedule(): void {
    this.#clearRefreshTimers();
    if (this.#disposed || this.#relayState !== "ready") return;
    const expiresAt = this.#config.expiresAt;
    if (expiresAt === null) return;

    const now = this.#now();
    const ttl = expiresAt - now;
    const lead = Math.min(300_000, Math.max(5_000, Math.floor(ttl * 0.1)));
    const base = Math.max(now + 1_000, expiresAt - lead);
    const jitterMax = Math.max(0, Math.min(5_000, expiresAt - 1_000 - base));
    const jitter = Math.floor(Math.max(0, Math.min(1, this.#random())) * jitterMax);
    const delay = Math.max(0, base + jitter - now);

    this.#refreshTimer = this.#timers.setTimeout(() => {
      this.#refreshTimer = null;
      void this.#scheduledRefresh();
    }, delay);
    this.#refreshTimer.unref?.();
  }

  async #scheduledRefresh(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      this.#scheduleRetry();
    }
  }

  #scheduleRetry(): void {
    if (this.#disposed || this.#relayState !== "ready") return;
    const expiresAt = this.#config.expiresAt;
    if (expiresAt === null) return;
    const now = this.#now();
    if (now > expiresAt + ICE_EXPIRY_RETRY_WINDOW_MS) {
      this.#logger.warn("ice refresh retries exhausted");
      return;
    }
    if (this.#retryTimer !== null) return;

    const delay = this.#retryDelayMs;
    this.#retryDelayMs = Math.min(ICE_RETRY_MAX_MS, this.#retryDelayMs * 2);
    this.#retryTimer = this.#timers.setTimeout(() => {
      this.#retryTimer = null;
      void this.#scheduledRefresh();
    }, delay);
    this.#retryTimer.unref?.();
  }

  #startRefresh(provider?: IceProvider): Promise<IceConfig> {
    return new Promise<IceConfig>((resolve, reject) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((doneResolve) => {
        resolveDone = doneResolve;
      });
      const timer = this.#timers.setTimeout(() => {
        this.#quietUntil = this.#now() + ICE_REFRESH_QUIET_MS;
        this.#settlePending(null, new Error("ice_refresh_timeout"));
      }, ICE_REFRESH_TIMEOUT_MS);
      timer.unref?.();

      this.#pending = {
        requestedProvider: provider,
        resolve,
        reject,
        done,
        resolveDone,
        timer,
      };
      try {
        this.#options.sendIceRefresh(provider);
      } catch (error) {
        this.#settlePending(null, new Error(`ice_refresh_send_failed: ${String(error)}`));
      }
    });
  }

  #settlePending(config: IceConfig | null, error?: Error): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    this.#timers.clearTimeout(pending.timer);
    pending.resolveDone();
    if (error !== undefined) {
      pending.reject(error);
    } else if (config !== null) {
      pending.resolve(config);
    }
  }

  async #refreshWithin(deadline: number, provider?: IceProvider): Promise<IceConfig> {
    const remaining = deadline - this.#now();
    if (remaining <= 0) throw new Error("ice_refresh_budget_exhausted");
    return this.#raceWithTimeout(this.refresh(provider), remaining, "ice_refresh_budget_exhausted");
  }

  async #waitWithin(promise: Promise<void>, deadline: number): Promise<void> {
    const remaining = deadline - this.#now();
    if (remaining <= 0) throw new Error("ice_refresh_budget_exhausted");
    await this.#raceWithTimeout(promise, remaining, "ice_refresh_budget_exhausted");
  }

  async #raceWithTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = this.#timers.setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      });
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== null) this.#timers.clearTimeout(timer);
    }
  }

  async #sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = this.#timers.setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  #clearRefreshTimers(): void {
    if (this.#refreshTimer !== null) {
      this.#timers.clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    if (this.#retryTimer !== null) {
      this.#timers.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }

  #clearTimers(): void {
    this.#clearRefreshTimers();
  }
}
