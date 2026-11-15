import { describe, expect, it } from "vitest";

import {
  classifyCandidatePair,
  DEFAULT_STUN_URL,
  parseIceUrl,
  resolveIceTransportPolicy,
  toNodeIceServers,
} from "./ice.js";

describe("parseIceUrl", () => {
  it("parses STUN URLs with an explicit port", () => {
    expect(parseIceUrl("stun:stun.cloudflare.com:3478")).toEqual({
      scheme: "stun",
      hostname: "stun.cloudflare.com",
      port: 3478,
      tcp: false,
    });
  });

  it("parses TURN URLs and their transport parameter", () => {
    expect(parseIceUrl("turn:turn.example.com:3478?transport=udp")).toEqual({
      scheme: "turn",
      hostname: "turn.example.com",
      port: 3478,
      tcp: false,
    });
    expect(parseIceUrl("turn:turn.example.com?transport=tcp")).toEqual({
      scheme: "turn",
      hostname: "turn.example.com",
      port: 3478,
      tcp: true,
    });
    expect(parseIceUrl("turns:turn.example.com:5349")).toEqual({
      scheme: "turns",
      hostname: "turn.example.com",
      port: 5349,
      tcp: false,
    });
  });

  it("parses bracketed IPv6 authorities", () => {
    expect(parseIceUrl("turn:[2001:db8::1]:3478?transport=udp")).toEqual({
      scheme: "turn",
      hostname: "2001:db8::1",
      port: 3478,
      tcp: false,
    });
  });

  it("rejects malformed URLs and invalid ports", () => {
    expect(parseIceUrl("http://example.com")).toBeNull();
    expect(parseIceUrl("stun:")).toBeNull();
    expect(parseIceUrl("stun:host:0")).toBeNull();
    expect(parseIceUrl("stun:host:not-a-port")).toBeNull();
  });
});

describe("toNodeIceServers", () => {
  it("keeps STUN URLs as strings", () => {
    expect(toNodeIceServers([{ urls: "stun:stun.example.com:3478" }])).toEqual([
      "stun:stun.example.com:3478",
    ]);
  });

  it("expands credentialed TURN URLs into libdatachannel entries", () => {
    expect(
      toNodeIceServers([
        {
          urls: ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"],
          username: "user",
          credential: "secret",
        },
      ]),
    ).toEqual([
      {
        hostname: "turn.example.com",
        port: 3478,
        username: "user",
        password: "secret",
        relayType: "TurnUdp",
      },
      {
        hostname: "turn.example.com",
        port: 5349,
        username: "user",
        password: "secret",
        relayType: "TurnTls",
      },
    ]);
  });

  it("drops TURN entries without credentials", () => {
    expect(toNodeIceServers([{ urls: "turn:turn.example.com:3478" }])).toEqual([DEFAULT_STUN_URL]);
  });

  it("falls back to a public STUN server when the list yields nothing", () => {
    expect(toNodeIceServers([])).toEqual([DEFAULT_STUN_URL]);
  });
});

describe("resolveIceTransportPolicy", () => {
  it("lets either side force TURN-only ICE", () => {
    expect(resolveIceTransportPolicy("relay", "all")).toBe("relay");
    expect(resolveIceTransportPolicy("all", "relay")).toBe("relay");
    expect(resolveIceTransportPolicy("all", "all")).toBe("all");
  });
});

describe("classifyCandidatePair", () => {
  it("reports direct pairs as p2p-direct", () => {
    expect(classifyCandidatePair({ local: { type: "host" }, remote: { type: "srflx" } })).toEqual({
      mode: "p2p-direct",
      detail: "host->srflx",
    });
  });

  it("reports TURN pairs as p2p-turn", () => {
    expect(classifyCandidatePair({ local: { type: "relay" }, remote: { type: "host" } })).toEqual({
      mode: "p2p-turn",
      detail: "relay->host",
    });
    expect(classifyCandidatePair({ local: { type: "srflx" }, remote: { type: "relay" } })).toEqual({
      mode: "p2p-turn",
      detail: "srflx->relay",
    });
  });

  it("returns null when no pair is selected yet", () => {
    expect(classifyCandidatePair(null)).toBeNull();
  });
});
