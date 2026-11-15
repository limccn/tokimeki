#!/usr/bin/env node
/**
 * Minimal node-datachannel viability probe: two PeerConnections in one process
 * negotiate a DataChannel over loopback and exchange one message.
 */

import nodeDataChannel from "node-datachannel";

const pc1 = new nodeDataChannel.PeerConnection("probe-1", { iceServers: [] });
const pc2 = new nodeDataChannel.PeerConnection("probe-2", { iceServers: [] });

const pendingCandidates = [];
let remoteReady = false;
const timeout = setTimeout(() => {
  console.error("PROBE FAIL: timeout");
  process.exit(1);
}, 15_000);

pc1.onLocalDescription((sdp, type) => {
  console.log(`pc1 local ${type}`);
  pc2.setRemoteDescription(sdp, type);
});
pc1.onLocalCandidate((candidate, mid) => {
  if (remoteReady) pc2.addRemoteCandidate(candidate, mid);
  else pendingCandidates.push([candidate, mid]);
});
pc2.onLocalDescription((sdp, type) => {
  console.log(`pc2 local ${type}`);
  pc1.setRemoteDescription(sdp, type);
  remoteReady = true;
  for (const [candidate, mid] of pendingCandidates.splice(0)) {
    pc1.addRemoteCandidate(candidate, mid);
  }
});
pc2.onLocalCandidate((candidate, mid) => {
  try {
    pc1.addRemoteCandidate(candidate, mid);
  } catch {
    pendingCandidates.push([candidate, mid]);
  }
});

pc2.onDataChannel((dc) => {
  console.log("pc2 data channel");
  dc.onMessage((msg) => {
    console.log(`pc2 got ${Buffer.from(msg).toString("utf8")}`);
    dc.sendMessage("pong");
  });
});

const dc = pc1.createDataChannel("probe", { ordered: true });
dc.onOpen(() => {
  console.log("pc1 data channel open");
  dc.sendMessage("ping");
});
dc.onMessage((msg) => {
  console.log(`pc1 got ${Buffer.from(msg).toString("utf8")}`);
  const pair = pc1.getSelectedCandidatePair();
  console.log(`pair local=${pair?.local.type} remote=${pair?.remote.type}`);
  clearTimeout(timeout);
  dc.close();
  pc1.close();
  pc2.close();
  setTimeout(() => process.exit(0), 300);
});
dc.onError((error) => console.error(`dc error: ${error}`));
pc1.onStateChange((state) => console.log(`pc1 state ${state}`));
pc2.onStateChange((state) => console.log(`pc2 state ${state}`));
