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
import { type CodeLanguage, highlightCode } from "./lib/highlight.js";
import { isSecureEntry, relayUrlForLocation } from "./lib/relay.js";
import { nextTabIndex } from "./lib/tabs.js";
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

function setButtonDisabled(id: string, disabled: boolean): void {
  byId<HTMLButtonElement>(id).disabled = disabled;
}

function addOptions(target: HTMLSelectElement, entries: Array<[string, string]>): void {
  for (const [value, label] of entries) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    target.append(option);
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

function setCodeOutput(id: string, text: string, language: CodeLanguage): void {
  const textarea = byId<HTMLTextAreaElement>(id);
  const highlight = byId<HTMLElement>(`${id}-highlight`);
  const scroller = highlight.closest<HTMLElement>("pre");

  textarea.value = text;
  highlight.replaceChildren();
  if (text.length > 0) {
    for (const token of highlightCode(text, language)) {
      if (token.kind === "plain") {
        highlight.append(document.createTextNode(token.text));
      } else {
        const span = document.createElement("span");
        span.className = `tok-${token.kind}`;
        span.textContent = token.text;
        highlight.append(span);
      }
    }
  }
  textarea.scrollTop = 0;
  textarea.scrollLeft = 0;
  if (scroller !== null) {
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
  }
}

function wireCodeField(id: string): void {
  const textarea = byId<HTMLTextAreaElement>(id);
  const highlight = byId<HTMLElement>(`${id}-highlight`);
  const scroller = highlight.closest<HTMLElement>("pre");
  if (scroller === null) return;
  textarea.addEventListener("scroll", () => {
    scroller.scrollTop = textarea.scrollTop;
    scroller.scrollLeft = textarea.scrollLeft;
  });
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

  const customField = input("host-custom-command");
  const customLabel = byId("host-custom-wrap");
  function setCustomFieldVisible(visible: boolean): void {
    customLabel.hidden = !visible;
    customField.hidden = !visible;
    if (!visible) customField.value = "";
  }
  setCustomFieldVisible(false);
  select("host-acp").addEventListener("change", () => {
    setCustomFieldVisible(select("host-acp").value === "custom");
  });

  const windowPresets = [
    ...document.querySelectorAll<HTMLInputElement>('input[name="host-window-preset"]'),
  ];
  const customWindow = input("host-window");
  function selectedWindowPreset(): string {
    return windowPresets.find((preset) => preset.checked)?.value ?? "";
  }
  function syncWindowField(): void {
    customWindow.hidden = selectedWindowPreset() !== "custom";
  }
  for (const preset of windowPresets) preset.addEventListener("change", syncWindowField);
  syncWindowField();

  const secretToggles = [...document.querySelectorAll<HTMLInputElement>("[data-secret-toggle]")];
  function setSecretVisibility(visible: boolean): void {
    for (const toggle of secretToggles) {
      toggle.checked = visible;
      toggle.setAttribute("aria-checked", String(visible));
    }
    for (const secret of document.querySelectorAll<HTMLInputElement>("input[data-secret]")) {
      secret.type = visible ? "text" : "password";
    }
  }
  for (const toggle of secretToggles) {
    toggle.addEventListener("change", () => setSecretVisibility(toggle.checked));
  }
  setSecretVisibility(secretToggles.some((toggle) => toggle.checked));

  for (const toggle of document.querySelectorAll<HTMLInputElement>('input[role="switch"]')) {
    const sync = (): void => {
      toggle.setAttribute("aria-checked", String(toggle.checked));
    };
    toggle.addEventListener("change", sync);
    sync();
  }

  const hints = [...document.querySelectorAll<HTMLDetailsElement>("details.hint")];
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Node)) return;
    for (const hint of hints) {
      if (hint.open && !hint.contains(event.target)) hint.open = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const hint of hints) hint.open = false;
  });

  wireCodeField("host-output");
  wireCodeField("attach-output");
  wireCodeField("attach-json");

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
      const preset = selectedWindowPreset();
      const windowSize = preset === "custom" ? customWindow.value.trim() : preset;
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
      setCodeOutput("host-output", command, "shell");
      setText("host-copy-status", "command generated");
      setText("host-download-status", "");
      setButtonDisabled("host-copy", false);
      setButtonDisabled("host-download", false);
      setError("host-error", null);
    } catch (error) {
      lastHost = null;
      setCodeOutput("host-output", "", "shell");
      setText("host-copy-status", "");
      setText("host-download-status", "");
      setButtonDisabled("host-copy", true);
      setButtonDisabled("host-download", true);
      setError("host-error", error instanceof Error ? error.message : "could not generate");
    }
  });

  byId("host-copy").addEventListener("click", () => {
    void copyText(byId<HTMLTextAreaElement>("host-output").value, "host-copy-status");
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
    setText("host-download-status", "downloaded — treat it as a secret and delete it when done");
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
      setCodeOutput("attach-output", command, "shell");
      setCodeOutput(
        "attach-json",
        buildViewerConfigJson({ relayUrl, session, sessionToken }),
        "json",
      );
      setText("attach-copy-status", "command generated");
      setButtonDisabled("attach-copy", false);
      setButtonDisabled("attach-copy-json", false);
      setError("attach-error", null);
    } catch (error) {
      setCodeOutput("attach-output", "", "shell");
      setCodeOutput("attach-json", "", "json");
      setText("attach-copy-status", "");
      setButtonDisabled("attach-copy", true);
      setButtonDisabled("attach-copy-json", true);
      setError("attach-error", error instanceof Error ? error.message : "could not generate");
    }
  });

  byId("attach-copy").addEventListener("click", () => {
    void copyText(byId<HTMLTextAreaElement>("attach-output").value, "attach-copy-status");
  });
  byId("attach-copy-json").addEventListener("click", () => {
    void copyText(byId<HTMLTextAreaElement>("attach-json").value, "attach-copy-status");
  });

  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-tab]")];

  function activateTab(tab: HTMLButtonElement): void {
    const target = tab.dataset.tab;
    for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
      panel.hidden = panel.dataset.panel !== target;
    }
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab));
  }

  const tablist = document.querySelector<HTMLElement>('[role="tablist"]');
  tablist?.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const current = target.closest<HTMLButtonElement>("[data-tab]");
    if (current === null) return;
    const index = tabs.indexOf(current);
    if (index < 0) return;
    const next = nextTabIndex(event.key, index, tabs.length);
    if (next === undefined) return;
    const nextTab = tabs[next];
    if (nextTab === undefined) return;
    event.preventDefault();
    activateTab(nextTab);
    nextTab.focus();
  });

  const initialTab = tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabs[0];
  if (initialTab !== undefined) activateTab(initialTab);

  setError("host-error", null);
  setError("attach-error", null);
}

if (typeof document !== "undefined") {
  start();
}
