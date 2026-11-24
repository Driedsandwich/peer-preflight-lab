import { diff, fetchPeer, inspect, readLock, resolvePeer, verdict } from "../core/src/preflight-core.mjs";

const tagName = "peer-preflight";
const symbols = { Pass: "○", Caution: "△", Block: "□" };
const severityOrder = { block: 0, caution: 1, info: 2, pass: 3 };
const finding = (id, severity, title, detail, evidence = {}) => ({ id, severity, title, detail, evidence });

const styles = `
  :host { display: block; font: 0.875rem/1.45 system-ui, sans-serif; }
  p, ul { margin: 0; }
  ul { padding: 0; list-style: none; }
  li { padding-block: 0.25em; overflow-wrap: anywhere; }
  strong { font-weight: 650; }
  .Pass { color: var(--peer-preflight-pass, var(--decision-1, #347256)); }
  .Caution { color: var(--peer-preflight-caution, var(--decision-3, #8a6027)); }
  .Block { color: var(--peer-preflight-block, var(--decision-2, #9e4848)); }
`;

function publicGet(url) {
  return fetch(url, {
    method: "GET",
    credentials: "omit",
    mode: "cors",
    referrerPolicy: "no-referrer",
    redirect: "error",
    cache: "no-store",
  });
}

function peerIdentity(url) {
  const { base, name } = resolvePeer(url);
  return { url: base + "/" + name, name, agentCount: null };
}

async function fetchLock(url) {
  const response = await publicGet(url);
  if (!response.ok) throw new Error("Peer lock fetch failed (HTTP " + response.status + ").");
  const { peers } = readLock(await response.text());
  const pins = new Map();
  for (const [address, pin] of Object.entries(peers)) {
    const peer = peerIdentity(address);
    if (pins.has(peer.url)) throw new TypeError("The lock lists the same peer more than once.");
    pins.set(peer.url, { peer, pin });
  }
  return pins;
}

async function checkPeer(identity, pin, callerOrigin) {
  const peer = { ...identity };
  const origin = new URL(peer.url).origin;
  let snapshot;
  try {
    snapshot = await fetchPeer(peer.url, {
      fetch(url) {
        if (new URL(url).origin !== origin) {
          throw new Error("Peer files must be served from the peer's origin.");
        }
        return publicGet(url);
      },
    });
  } catch (error) {
    const findings = [finding("peer-unavailable", "block", "Could not read the peer's public files",
      "Check the network URL, artifact origin, redirects, and CORS.", { error: String(error?.message ?? error) })];
    return { peer, verdict: "Block", findings, changes: null, fingerprint: null };
  }

  const tools = snapshot.network?.tools;
  if (Array.isArray(tools)) {
    peer.agentCount = tools.filter((tool) => typeof tool?.name === "string" && !tool.class && !tool.toolbox).length;
  }
  const findings = inspect(snapshot, { callerOrigin });
  const fingerprint = snapshot.response.links.unavailable ? null : snapshot.sha256;
  const changes = pin && fingerprint ? await diff(pin, snapshot) : null;
  if (pin?.verdict === "Block") {
    findings.unshift(finding("pin-blocked", "block", "Blocked in the peer lock",
      "The lock records a Block decision for this peer."));
  }
  if (changes?.changed) {
    findings.unshift(finding("pin-changed", "caution", "Publication changed since the pinned version",
      "The current fingerprint differs from the one in the lock.",
      { before: changes.fingerprint.before, after: changes.fingerprint.after }));
  }
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  return { peer, verdict: verdict(findings, changes), findings, changes, fingerprint };
}

class PeerPreflight extends HTMLElement {
  static observedAttributes = ["pin"];

  #status;
  #connected = false;
  #lock;
  #run;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = this.ownerDocument.createElement("style");
    style.textContent = styles;
    this.#status = this.ownerDocument.createElement("div");
    this.#status.setAttribute("aria-live", "polite");
    root.append(style, this.#status);
  }

  connectedCallback() {
    this.#connected = true;
    this.verifyLock().catch(() => {});
  }

  disconnectedCallback() {
    this.#connected = false;
    this.#lock = null;
    this.#run = null;
  }

  attributeChangedCallback(name, before, after) {
    if (before === after) return;
    this.#lock = null;
    if (this.#connected) this.verifyLock().catch(() => {});
  }

  #readLock() {
    const pin = this.getAttribute("pin")?.trim();
    if (!pin) throw new TypeError("Set the pin attribute to a version 1 peer lock.");
    const url = new URL(pin, this.ownerDocument.baseURI);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new TypeError("Use a public HTTP or HTTPS URL for the peer lock.");
    }
    url.hash = "";
    if (this.#lock?.url === url.href) return this.#lock;
    const lock = { url: url.href, pending: fetchLock(url.href).catch((error) => {
      if (this.#lock === lock) this.#lock = null;
      throw error;
    }) };
    this.#lock = lock;
    return lock;
  }

  async #pins() {
    return this.#readLock().pending;
  }

  #callerOrigin() {
    return new URL(this.ownerDocument.URL).origin;
  }

  async check(url) {
    const peer = peerIdentity(url);
    const pins = await this.#pins().catch(() => null);
    return checkPeer(peer, pins?.get(peer.url)?.pin, this.#callerOrigin());
  }

  async shouldAllow(url) {
    try {
      const peer = peerIdentity(url);
      const lock = this.#readLock();
      const pins = await lock.pending;
      const pin = pins.get(peer.url)?.pin;
      if (!pin || this.#lock !== lock) return false;
      const result = await checkPeer(peer, pin, this.#callerOrigin());
      return this.#lock === lock && result.fingerprint === pin.sha256 && result.verdict !== "Block";
    } catch {
      return false;
    }
  }

  async verifyLock() {
    const run = {};
    this.#run = run;
    this.#message("Checking pinned peers...");
    try {
      const pins = await this.#pins();
      const callerOrigin = this.#callerOrigin();
      const results = await Promise.all(Array.from(pins.values(), ({ peer, pin }) => checkPeer(peer, pin, callerOrigin)));
      if (this.#run === run) this.#render(results);
      for (const result of results) {
        if (this.#run !== run) break;
        this.#emit("result", result);
      }
      if (this.#run === run) this.#emit("done", results);
      return results;
    } catch (error) {
      if (this.#run === run) this.#message("Could not verify the peer lock.");
      throw error;
    }
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(tagName + ":" + type, { detail, bubbles: true, composed: true }));
  }

  #message(text) {
    const message = this.ownerDocument.createElement("p");
    message.textContent = text;
    this.#status.replaceChildren(message);
  }

  #render(results) {
    if (!results.length) {
      this.#message("No pinned peers.");
      return;
    }
    const list = this.ownerDocument.createElement("ul");
    list.setAttribute("role", "list");
    for (const result of results) {
      const row = this.ownerDocument.createElement("li");
      row.setAttribute("title", result.peer.url);
      const label = this.ownerDocument.createElement("strong");
      label.className = result.verdict;
      const symbol = this.ownerDocument.createElement("span");
      symbol.setAttribute("aria-hidden", "true");
      symbol.textContent = symbols[result.verdict];
      label.append(symbol, " " + result.verdict);
      const change = result.changes ? (result.changes.changed ? "Changed" : "Matches pin") : "Version unverified";
      row.append(result.peer.name + ": ", label, " · " + change);
      list.append(row);
    }
    this.#status.replaceChildren(list);
  }
}

function activeElement() {
  return document.querySelector(tagName + "[pin]");
}

window.peerPreflight = Object.assign(window.peerPreflight ?? {}, {
  async check(url) {
    const element = activeElement();
    if (element) return element.check(url);
    return checkPeer(peerIdentity(url), null, new URL(document.URL).origin);
  },
  async verifyLock() {
    return activeElement()?.verifyLock() ?? [];
  },
  async shouldAllow(url) {
    return activeElement()?.shouldAllow(url) ?? false;
  },
});

if (!customElements.get(tagName)) customElements.define(tagName, PeerPreflight);
