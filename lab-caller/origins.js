// The only place the lab's addresses are written by hand. Each role has one address:
//   caller  the folder that serves lab-caller (an origin plus any path prefix, no trailing slash)
//   peers   the origin that serves lab-peers at its root
//   denied  an origin listed in peer_policy.deny_origins. It is never contacted.
// `active` says which set the HOCON, manifests and redirect files currently carry.
// Do not edit it by hand: `node scripts/set_origins.mjs --local|--public` rewrites those
// files together with this line, then rebuilds the networks.
export const presets = {
  public: {
    caller: "https://driedsandwich.github.io/peer-preflight-lab/lab-caller",
    peers: "https://peer-preflight-peers.vercel.app",
    // `.invalid` is reserved and never resolves, so a mistake cannot reach a real site.
    denied: "https://denied-peer.invalid",
  },
  local: {
    caller: "http://127.0.0.1:8081",
    peers: "http://localhost:8082",
    // The same peer server under its other loopback name.
    denied: "http://127.0.0.1:8082",
  },
};

export const active = "public";

export const { caller: callerBase, peers: peerOrigin, denied: deniedOrigin } = presets[active];
export const callerOrigin = new URL(callerBase).origin;
