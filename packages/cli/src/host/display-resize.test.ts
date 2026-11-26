import { describe, expect, it } from "vitest";

import { resolveDisplayResizeGate } from "./display-resize.js";

describe("resolveDisplayResizeGate", () => {
  it("allows a fixed resize when the relay and every client support it", () => {
    expect(
      resolveDisplayResizeGate({
        fixedGeometryEnabled: true,
        relayReady: true,
        relaySupported: true,
        clients: [
          { clientId: "viewer-1", supported: true },
          { clientId: "listener-1", supported: true },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it("allows a resize with no connected clients", () => {
    expect(
      resolveDisplayResizeGate({
        fixedGeometryEnabled: true,
        relayReady: true,
        relaySupported: true,
        clients: [],
      }),
    ).toEqual({ ok: true });
  });

  it("blocks while the relay is reconnecting", () => {
    const gate = resolveDisplayResizeGate({
      fixedGeometryEnabled: true,
      relayReady: false,
      relaySupported: true,
      clients: [],
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("relay connection");
  });

  it("blocks when the relay cannot carry display-size", () => {
    const gate = resolveDisplayResizeGate({
      fixedGeometryEnabled: true,
      relayReady: true,
      relaySupported: false,
      clients: [],
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("relay");
  });

  it("blocks while any viewer or listener is a legacy client", () => {
    const gate = resolveDisplayResizeGate({
      fixedGeometryEnabled: true,
      relayReady: true,
      relaySupported: true,
      clients: [
        { clientId: "viewer-1", supported: true },
        { clientId: "legacy-viewer", supported: false },
      ],
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("legacy-viewer");
  });

  it("blocks when fixed geometry is disabled", () => {
    const gate = resolveDisplayResizeGate({
      fixedGeometryEnabled: false,
      relayReady: true,
      relaySupported: true,
      clients: [],
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("fixed geometry");
  });
});
