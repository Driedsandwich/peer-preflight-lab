import { diff, fetchPeer, inspect, readLock, resolvePeer, verdict, writeLock } from "../core/src/preflight-core.mjs";

const lockKey = "peer-preflight.lock.v1";
const severityOrder = { block: 0, caution: 1, info: 2, pass: 3 };
const makeFinding = (id, severity, title, detail, evidence = {}) => ({ id, severity, title, detail, evidence });

export function browserGet(fetch, url, { redirect = "follow", cache = "no-store" } = {}) {
  return fetch(url, { method: "GET", credentials: "omit", mode: "cors", referrerPolicy: "no-referrer", redirect, cache });
}

function readSaved(storage) {
  const text = storage.getItem(lockKey);
  if (text === null) return { lock: { version: 1, peers: {} }, snapshots: {} };
  const saved = JSON.parse(text);
  return { lock: readLock(saved.lock), snapshots: saved.snapshots };
}

function saveEntry(storage, url, entry, snapshot) {
  const { lock, snapshots } = readSaved(storage);
  lock.peers[url] = entry;
  storage.setItem(lockKey, JSON.stringify({
    lock: writeLock(lock),
    snapshots: { ...snapshots, [url]: snapshot },
  }));
}

export function exportLock(storage) {
  return writeLock(readSaved(storage).lock);
}

export function clearLock(storage) {
  storage.removeItem(lockKey);
}

export function saveDecision(storage, { result, snapshot }, decision = result.verdict) {
  if (!snapshot || (decision !== "Block" && result.verdict === "Block")) {
    throw new Error("This decision requires a fingerprint of a checked version.");
  }
  saveEntry(storage, result.peer.url, {
    sha256: result.fingerprint,
    pinned_at: new Date().toISOString(),
    verdict: decision,
  }, snapshot);
}

export async function seedDemo(storage, url, demo) {
  const entry = readLock(JSON.stringify(demo.lock)).peers[url];
  if (!entry || (await diff(entry, demo.snapshot)).changed) {
    throw new Error("The saved demo pin does not match this sample.");
  }
  saveEntry(storage, url, entry, demo.snapshot);
}

export async function checkPeer(input, { fetch, callerOrigin, storage, onStorageError }) {
  const { base, name } = resolvePeer(input.trim());
  const peer = { url: base + "/" + name, name, agentCount: null };
  let snapshot;
  try {
    snapshot = await fetchPeer(peer.url, {
      fetch: (url, options) => browserGet(fetch, url, options),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const finding = makeFinding("peer-unavailable", "block", "Could not read the peer's public files",
      "Check the network URL and make sure the peer permits browser reads via CORS.", { error: detail });
    return { snapshot: null, result: { peer, verdict: "Block", findings: [finding], changes: null, fingerprint: null } };
  }

  const tools = snapshot.network?.tools;
  if (Array.isArray(tools)) {
    peer.agentCount = tools.filter((tool) => typeof tool?.name === "string" && !tool.class && !tool.toolbox).length;
  }
  // The prototype has no visitor-field grants for any peer.
  const findings = inspect(snapshot, { callerOrigin, allowedFields: [] });
  const graphAccepted = findings.some(({ id, severity }) => id === "network-validation" && severity === "pass");
  findings.unshift(makeFinding("exact-network-name", "pass", "exact network name", "The manifest explicitly publishes this name."));
  if (graphAccepted && !findings.some(({ id }) => id === "agent-cycle")) {
    findings.push(makeFinding("no-agent-cycle", "pass", "no internal call cycle", "No cycle between agents in this network was found."));
  }
  const crossOriginReads = Object.values(snapshot.response).filter((value) =>
    value?.status >= 200 && value.status < 300 && new URL(value.finalUrl ?? value.requestedUrl).origin !== callerOrigin);
  if (crossOriginReads.length && !findings.some(({ id }) => id === "missing-cors" || id === "links-unavailable")) {
    findings.push(makeFinding("cors-ok", "pass", "CORS ok", "The cross-origin public files could be read."));
  }

  let changes = null;
  try {
    const { lock, snapshots } = readSaved(storage);
    const entry = lock.peers[peer.url];
    if (entry) changes = await diff(snapshots?.[peer.url] ?? entry, snapshot);
    if (entry?.verdict === "Block") {
      findings.unshift(makeFinding("locally-blocked", "block", "Blocked in this browser",
        "Clear the local peer lock to remove the saved decision."));
    }
  } catch {
    onStorageError?.();
  }
  if (changes?.changed) {
    const instructionsChanged = changes.instructions.length > 0;
    findings.unshift(makeFinding("pin-changed", "caution",
      instructionsChanged ? "Instructions changed since the pinned version" : "Publication changed since the pinned version",
      "The current fingerprint differs from the one saved in this browser.",
      { before: changes.fingerprint.before, after: changes.fingerprint.after }));
  }
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  return { snapshot, result: { peer, verdict: verdict(findings, changes), findings, changes, fingerprint: snapshot.sha256 } };
}

export function actionControls(result) {
  const block = { id: "block", label: "Block", style: "outline", disabled: result.fingerprint === null };
  if (result.verdict === "Pass") {
    return [{ id: "pin", label: "Pin this version", style: "primary" }, block];
  }
  const actions = [{ id: "review", label: "Review details", style: "outline" }, block];
  if (result.verdict === "Caution") actions.push({ id: "pin", label: "Pin anyway", style: "text-button" });
  return actions;
}
