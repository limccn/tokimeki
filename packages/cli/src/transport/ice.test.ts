import { describe, expect, it } from "vitest";

import {
  classifyCandidatePair,
  DEFAULT_STUN_URL,
  isLocalOrPrivateAddress,
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

describe("isLocalOrPrivateAddress", () => {
  it("recognizes private and local IPv4 ranges", () => {
    for (const address of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.10",
      "127.0.0.1",
      "169.254.10.20",
      "192.168.1.10:54321",
    ]) {
      expect(isLocalOrPrivateAddress(address)).toBe(true);
    }
  });

  it("recognizes IPv6 loopback, ULA, link-local, and IPv4-mapped addresses", () => {
    for (const address of [
      "::1",
      "0:0:0:0:0:0:0:1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%eth0",
      "::ffff:192.168.1.10",
      "[fd00::1]",
      "[fd00::1]:1234",
    ]) {
      expect(isLocalOrPrivateAddress(address)).toBe(true);
    }
  });

  it("rejects public, mDNS, unknown, and malformed addresses", () => {
    for (const address of [
      "8.8.8.8",
      "172.32.0.1",
      "192.169.1.1",
      "2001:db8::1",
      "::ffff:8.8.8.8",
      "host.local",
      "",
      "not-an-address",
      "999.1.1.1",
      "fe80:",
      "fc00:zz",
      "fd00:::1",
      "1:2:3:4:5:6:7",
    ]) {
      expect(isLocalOrPrivateAddress(address)).toBe(false);
    }
    expect(isLocalOrPrivateAddress(undefined)).toBe(false);
  });
});

describe("classifyCandidatePair", () => {
  it("reports direct pairs as p2p-direct", () => {
    expect(classifyCandidatePair({ local: { type: "host" }, remote: { type: "srflx" } })).toEqual({
      mode: "p2p-direct",
      detail: "host->srflx",
      lan: false,
    });
  });

  it("marks a pair LAN only when both addresses are private/local", () => {
    expect(
      classifyCandidatePair({
        local: { type: "host", address: "192.168.1.10" },
        remote: { type: "host", address: "192.168.1.20" },
      }),
    ).toEqual({ mode: "p2p-direct", detail: "host->host", lan: true });

    expect(
      classifyCandidatePair({
        local: { type: "host", address: "192.168.1.10" },
        remote: { type: "srflx", address: "203.0.113.5" },
      }),
    ).toEqual({ mode: "p2p-direct", detail: "host->srflx", lan: false });
  });

  it("reports TURN pairs as p2p-turn and never as LAN", () => {
    expect(classifyCandidatePair({ local: { type: "relay" }, remote: { type: "host" } })).toEqual({
      mode: "p2p-turn",
      detail: "relay->host",
      lan: false,
    });
    expect(
      classifyCandidatePair({
        local: { type: "relay", address: "10.0.0.2" },
        remote: { type: "relay", address: "10.0.0.3" },
      }),
    ).toEqual({ mode: "p2p-turn", detail: "relay->relay", lan: false });
  });

  it("returns null when no pair is selected yet", () => {
    expect(classifyCandidatePair(null)).toBeNull();
  });
});
