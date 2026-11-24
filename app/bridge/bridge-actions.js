import { checkPeerAction } from "../check-peer-action.js";
import { actionReport, inspectPublicPeer } from "../preflight.js";

export function registerActions(actions) {
  actions.register({
    ...checkPeerAction,
    description: "Check a peer network URL using only its public files. Returns the verdict, evidence and fingerprint from a fresh check.",
    availability: "bridge",
    callerOrigins: ["*"],
    async execute({ url }, { signal } = {}) {
      const check = await inspectPublicPeer(url, { callerOrigin: location.origin, signal });
      return check.ok ? { ok: true, ...actionReport(check.result) } : check;
    },
  });
}
