import { page } from "./app.js";
import { checkPeerAction } from "./check-peer-action.js";

const schema = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
const decisionSchema = schema({
  url: checkPeerAction.inputSchema.properties.url,
  fingerprint: { type: "string", minLength: 64, maxLength: 64, description: "Full SHA-256 fingerprint from the check." },
});

async function review(action, args, result) {
  const { AssistantMount } = await import("./site.js");
  return AssistantMount.review([{
    action,
    origin: location.origin,
    effect: "write",
    arguments: args,
    result,
  }]);
}

function savePeer(args, kind, signal) {
  const action = kind === "pin" ? "pin_version" : "block_peer";
  return page.savePeer(args, kind, (result) => review(action, args, result), signal);
}

export function registerActions(actions) {
  actions.register({
    ...checkPeerAction,
    description: "Check the exact URL the visitor wants to inspect. Return a verdict, evidence, fingerprint and any diff against this browser's saved version. Leaves the page unchanged. To read the current panel, use read_result.",
    execute: (args, { signal } = {}) => page.checkPeer(args, signal),
  });
  actions.register({
    name: "read_result",
    description: "Read the latest result shown on this page, sample links, privacy notes and local lock count and version. Call before explaining this page or clearing the lock.",
    effect: "read",
    inputSchema: schema({}),
    execute: () => page.readResult(),
  });
  actions.register({
    name: "pin_version",
    description: "Pin the checked version in this browser only. Call only when asked to pin. First read the result or check the exact URL in this turn, then pass its URL and fingerprint. The browser asks before saving.",
    effect: "write",
    inputSchema: decisionSchema,
    execute: (args, { signal } = {}) => savePeer(args, "pin", signal),
  });
  actions.register({
    name: "block_peer",
    description: "Save a local block for the checked peer. Call only when asked to block. First read the result or check the exact URL in this turn, then pass its URL and fingerprint. The browser asks before saving.",
    effect: "write",
    inputSchema: decisionSchema,
    execute: (args, { signal } = {}) => savePeer(args, "block", signal),
  });
  actions.register({
    name: "export_lock",
    description: "Start a local download of peers.lock.json when asked. The browser asks before starting the download. Returns the filename and preserves the lock.",
    effect: "write",
    inputSchema: schema({}),
    async execute(args, { signal } = {}) {
      if (!await review("export_lock", args) || signal?.aborted) {
        return { ok: false, cancelled: true, reason: "The download was not started." };
      }
      return page.exportLock();
    },
  });
  actions.register({
    name: "clear_lock",
    description: "Remove all saved decisions from this browser only. Call only when asked to clear. Read the lock in this turn and pass its version. The browser asks before deleting.",
    effect: "irreversible",
    inputSchema: schema({
      expectedVersion: { type: "integer", minimum: 0, description: "Current lock.version from read_result in this turn." },
    }),
    execute: (args) => page.clearLock(args),
  });
}
