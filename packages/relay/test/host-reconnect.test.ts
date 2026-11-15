import { decodeFrame, encodeFrame } from "@limccn/tokimeki-protocol";
import { describe, expect, it } from "vitest";

import {
  connectWorker,
  helloFor,
  MASTER_TOKEN,
  openHost,
  openViewer,
  SESSION_TOKEN,
  sleep,
} from "./helpers";

function outputFrame(seq: number, text: string): Uint8Array {
  return encodeFrame({ type: "output", seq, payload: new TextEncoder().encode(text) });
}

function inputFrame(text: string): Uint8Array {
  return encodeFrame({ type: "input", payload: new TextEncoder().encode(text) });
}

function hasControl(
  socket: { readonly controls: Array<Record<string, unknown>> },
  predicate: (message: Record<string, unknown>) => boolean,
): boolean {
  return socket.controls.some(predicate);
}

describe("host relay reconnection", () => {
  it("replaces a stale host socket with the same authenticated client id", async () => {
    const sessionId = "host-replace";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");

    const replacement = await connectWorker(sessionId, {
      master: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    replacement.send(helloFor(sessionId, "host", "host-1", { cols: 80, rows: 24 }));

    const welcome = await replacement.waitForType("welcome");
    expect(welcome.hostOnline).toBe(true);
    const clients = welcome.clients as Array<{ clientId: string }>;
    const clientIds = clients.map((client) => client.clientId);
    expect(clientIds).toContain("viewer-1");
    // The stale host socket must not count as a second presence entry.
    expect(clientIds).not.toContain("host-1");

    // The old socket is rejected as a duplicate replacement and closed.
    const error = await host.waitForType("error");
    expect(error.code).toBe("duplicate_client_id");
    const closed = await host.waitForClose();
    expect(closed.code).toBe(4003);

    // The viewer must not observe a host disconnect: routing moved silently.
    await sleep(150);
    expect(
      hasControl(
        viewer,
        (message) => message.type === "peer-left" && message.clientId === "host-1",
      ),
    ).toBe(false);
    expect(
      hasControl(viewer, (message) => message.type === "host" && message.online === false),
    ).toBe(false);

    // Viewer input is routed to the new host socket.
    viewer.sendBinary(inputFrame("hello-new-host\n"));
    const received = decodeFrame(await replacement.waitForBinary());
    expect(received.type).toBe("input");
    if (received.type === "input") {
      expect(new TextDecoder().decode(received.payload)).toBe("hello-new-host\n");
    }

    // New host output is broadcast to the still-connected viewer.
    replacement.sendBinary(outputFrame(1, "from-new-host"));
    const delivered = decodeFrame(await viewer.waitForBinary());
    expect(delivered.type).toBe("output");
    if (delivered.type === "output") {
      expect(delivered.seq).toBe(1);
      expect(new TextDecoder().decode(delivered.payload)).toBe("from-new-host");
    }

    replacement.close();
    viewer.close();
  });

  it("replaces the host even when the session is at the client limit", async () => {
    // Test config sets TOKIMEKI_MAX_CLIENTS_PER_SESSION=3.
    const sessionId = "host-replace-full";
    const host = await openHost(sessionId);
    const viewer1 = await openViewer(sessionId, "viewer-1");
    const viewer2 = await openViewer(sessionId, "viewer-2");

    const replacement = await connectWorker(sessionId, {
      master: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    replacement.send(helloFor(sessionId, "host", "host-1"));

    const welcome = await replacement.waitForType("welcome");
    expect(welcome.hostOnline).toBe(true);
    const closed = await host.waitForClose();
    expect(closed.code).toBe(4003);

    replacement.sendBinary(outputFrame(2, "after-full-replace"));
    for (const viewer of [viewer1, viewer2]) {
      const frame = decodeFrame(await viewer.waitForBinary());
      expect(frame.type).toBe("output");
      if (frame.type === "output") {
        expect(new TextDecoder().decode(frame.payload)).toBe("after-full-replace");
      }
    }

    replacement.close();
    viewer1.close();
    viewer2.close();
  });

  it("rejects a replacement attempt with the wrong host token without touching the host", async () => {
    const sessionId = "host-replace-wrong-token";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");

    const impostor = await connectWorker(sessionId, {
      master: MASTER_TOKEN,
      token: "different-session-token",
    });
    impostor.send(helloFor(sessionId, "host", "host-1"));

    const error = await impostor.waitForType("error");
    expect(error.code).toBe("unauthorized");
    const closed = await impostor.waitForClose();
    expect(closed.code).toBe(4001);

    // The live host is still connected and still drives the viewer.
    expect(host.closeInfo).toBeNull();
    host.sendBinary(outputFrame(3, "host-still-online"));
    const frame = decodeFrame(await viewer.waitForBinary());
    expect(frame.type).toBe("output");
    if (frame.type === "output") {
      expect(new TextDecoder().decode(frame.payload)).toBe("host-still-online");
    }
    await sleep(150);
    expect(
      hasControl(viewer, (message) => message.type === "host" && message.online === false),
    ).toBe(false);

    host.close();
    viewer.close();
  });

  it("does not let a host take over an active viewer's client id", async () => {
    const sessionId = "host-replace-viewer-id";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");

    const impostor = await connectWorker(sessionId, {
      master: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    impostor.send(helloFor(sessionId, "host", "viewer-1"));

    const error = await impostor.waitForType("error");
    expect(error.code).toBe("duplicate_client_id");
    const closed = await impostor.waitForClose();
    expect(closed.code).toBe(4003);

    // The viewer and the original host are untouched.
    expect(viewer.closeInfo).toBeNull();
    host.sendBinary(outputFrame(4, "viewer-still-online"));
    const frame = decodeFrame(await viewer.waitForBinary());
    expect(frame.type).toBe("output");
    await sleep(150);
    expect(
      hasControl(
        viewer,
        (message) => message.type === "peer-left" && message.clientId === "viewer-1",
      ),
    ).toBe(false);

    host.close();
    viewer.close();
  });
});
