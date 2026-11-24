/**
 * Static no-JWT onboarding page.
 *
 * Everything happens in memory: no fetch/XHR, no localStorage/sessionStorage,
 * no cookies, no analytics. Credentials are rendered with textContent/value
 * only and downloaded as a local v1 config blob when the user asks.
 */

import { ACP_CATALOG } from "./lib/acp.js";
import { generateAttachCommand, generateHostCommand, SHELLS, type Shell } from "./lib/commands.js";
import { buildHostConfigEnvelope, buildViewerConfigJson } from "./lib/config.js";
import { isSecureEntry, relayUrlForLocation } from "./lib/relay.js";
import { randomSlug, randomToken } from "./lib/token.js";
import {
  SiteError,
  validateCustomCommand,
  validateNamespace,
  validateRelayUrl,
  validateSession,
  validateToken,
  validateWindow,
} from "./lib/validate.js";

interface HostDraft {
  readonly relayUrl: string;
  readonly token: string;
  readonly namespace: string;
  readonly session: string;
  readonly sessionToken: string;
  readonly acpId: string;
  readonly customCommand?: string;
  readonly shell: Shell;
  readonly windowSize?: string;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing element #${id}`);
  return element as T;
}

function input(id: string): HTMLInputElement {
  return byId<HTMLInputElement>(id);
}

function select(id: string): HTMLSelectElement {
  return byId<HTMLSelectElement>(id);
}

function setText(id: string, text: string): void {
  byId(id).textContent = text;
}

function setError(id: string, message: string | null): void {
  const element = byId(id);
  element.textContent = message ?? "";
  element.hidden = message === null;
}

function addOptions(target: HTMLSelectElement, entries: Array<[string, string]>): void {
  for (const [value, label] of entries) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    target.append(option);
  }
}

function showSecrets(visible: boolean): void {
  for (const element of document.querySelectorAll<HTMLInputElement>("input[type=password]")) {
    element.type = visible ? "text" : "password";
  }
}

async function copyText(text: string, statusId: string): Promise<void> {
  if (text.length === 0) return;
  try {
    await navigator.clipboard.writeText(text);
    setText(statusId, "copied");
  } catch {
    setText(statusId, "copy failed; select the text and copy manually");
  }
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function start(): void {
  const secure = isSecureEntry(window.location, window.isSecureContext);
  const warning = byId("secure-warning");
  warning.hidden = secure;
  if (!secure) {
    setText(
      "secure-warning",
      "This page must be served over HTTPS (except localhost) before entering credentials.",
    );
  }

  let relayUrl = "";
  try {
    relayUrl = relayUrlForLocation(window.location);
    validateRelayUrl(relayUrl);
    setText("relay-url", relayUrl);
  } catch (error) {
    warning.hidden = false;
    setText("secure-warning", error instanceof Error ? error.message : "Unsupported page origin");
  }

  addOptions(
    select("host-acp"),
    ACP_CATALOG.map((entry): [string, string] => [entry.id, entry.label]).concat([
      ["custom", "Custom command"],
    ]),
  );
  addOptions(
    select("host-shell"),
    SHELLS.map((shell): [string, string] => [shell, shell]),
  );
  addOptions(
    select("attach-shell"),
    SHELLS.map((shell): [string, string] => [shell, shell]),
  );
  select("host-shell").value = "bash";
  select("attach-shell").value = "bash";

  const customWrap = byId("host-custom-wrap");
  customWrap.hidden = true;
  select("host-acp").addEventListener("change", () => {
    customWrap.hidden = select("host-acp").value !== "custom";
  });

  byId("show-secrets").addEventListener("change", (event) => {
    showSecrets((event.target as HTMLInputElement).checked);
  });

  byId("host-generate-session").addEventListener("click", () => {
    const namespace = input("host-namespace").value.trim();
    if (namespace.length === 0) {
      setError("host-error", "Enter the namespace first");
      return;
    }
    try {
      validateNamespace(namespace);
      input("host-session").value = `${namespace}.${randomSlug()}`;
      setError("host-error", null);
    } catch (error) {
      setError("host-error", error instanceof Error ? error.message : "invalid namespace");
    }
  });

  byId("host-generate-token").addEventListener("click", () => {
    input("host-session-token").value = randomToken();
    setError("host-error", null);
  });

  let lastHost: HostDraft | null = null;

  byId("host-generate").addEventListener("click", () => {
    try {
      if (!secure) throw new SiteError("HTTPS is required before entering credentials");
      validateRelayUrl(relayUrl);
      const namespace = input("host-namespace").value.trim();
      const token = input("host-token").value;
      const session = input("host-session").value.trim();
      const sessionToken = input("host-session-token").value;
      const windowSize = input("host-window").value.trim();
      const acpId = select("host-acp").value;
      const customCommand = input("host-custom-command").value.trim();
      validateNamespace(namespace);
      validateToken(token, "Host token");
      validateSession(session, namespace);
      validateToken(sessionToken, "Session token");
      validateWindow(windowSize);
      if (acpId === "custom") validateCustomCommand(customCommand);
      const shell = select("host-shell").value as Shell;
      const command = generateHostCommand({
        relayUrl,
        token,
        namespace,
        session,
        sessionToken,
        acpId,
        ...(customCommand.length === 0 ? {} : { customCommand }),
        shell,
        ...(windowSize.length === 0 ? {} : { windowSize }),
      });
      lastHost = {
        relayUrl,
        token,
        namespace,
        session,
        sessionToken,
        acpId,
        ...(customCommand.length === 0 ? {} : { customCommand }),
        shell,
        ...(windowSize.length === 0 ? {} : { windowSize }),
      };
      setText("host-output", command);
      setText("host-copy-status", "");
      byId("host-download").removeAttribute("disabled");
      setError("host-error", null);
    } catch (error) {
      lastHost = null;
      byId("host-download").setAttribute("disabled", "");
      setError("host-error", error instanceof Error ? error.message : "could not generate");
    }
  });

  byId("host-copy").addEventListener("click", () => {
    void copyText(byId("host-output").textContent ?? "", "host-copy-status");
  });

  byId("host-download").addEventListener("click", () => {
    if (lastHost === null) return;
    downloadText(
      "tokimeki-config.json",
      buildHostConfigEnvelope({
        relayUrl: lastHost.relayUrl,
        token: lastHost.token,
        namespace: lastHost.namespace,
        session: lastHost.session,
        sessionToken: lastHost.sessionToken,
        ...(lastHost.windowSize === undefined ? {} : { windowSize: lastHost.windowSize }),
      }),
    );
    setText(
      "host-download-status",
      "downloaded: chmod 600 the file, use it with `tokimeki --config`, and delete it when done",
    );
  });

  byId("attach-generate").addEventListener("click", () => {
    try {
      if (!secure) throw new SiteError("HTTPS is required before entering credentials");
      validateRelayUrl(relayUrl);
      const session = input("attach-session").value.trim();
      const sessionToken = input("attach-token").value;
      const namespace = session.includes(".") ? (session.split(".")[0] ?? "") : "";
      validateNamespace(namespace);
      validateSession(session, namespace);
      validateToken(sessionToken, "Session token");
      const shell = select("attach-shell").value as Shell;
      const listener = input("attach-listener").checked;
      const command = generateAttachCommand({
        relayUrl,
        session,
        sessionToken,
        shell,
        listener,
      });
      setText("attach-output", command);
      setText("attach-json", buildViewerConfigJson({ relayUrl, session, sessionToken }));
      byId("attach-copy-json").removeAttribute("disabled");
      setError("attach-error", null);
    } catch (error) {
      byId("attach-copy-json").setAttribute("disabled", "");
      setError("attach-error", error instanceof Error ? error.message : "could not generate");
    }
  });

  byId("attach-copy").addEventListener("click", () => {
    void copyText(byId("attach-output").textContent ?? "", "attach-copy-status");
  });
  byId("attach-copy-json").addEventListener("click", () => {
    void copyText(byId("attach-json").textContent ?? "", "attach-copy-status");
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
        panel.hidden = panel.dataset.panel !== tab;
      }
      for (const other of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
        other.setAttribute("aria-selected", other === button ? "true" : "false");
      }
    });
  }

  setError("host-error", null);
  setError("attach-error", null);
}

if (typeof document !== "undefined") {
  start();
}
