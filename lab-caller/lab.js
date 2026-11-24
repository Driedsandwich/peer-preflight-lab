import { peerOrigin, runProbe } from "./probe.js";
import { modelRoute } from "./scripted-router.js";

const get = id => document.getElementById(id);
const buttons = [...document.querySelectorAll("[data-probe]")];
// The folder this page is served from. On GitHub Pages it has a path prefix, so
// location.origin alone would point at the wrong place.
const caller = new URL("./", location.href).href.replace(/\/$/, "");
const dialog = get("consent");
const status = get("status");

function requestConsent(info) {
  get("destination").textContent = info.peerLabel + " · " + info.origin;
  get("request").textContent = "Delegated request: " + info.requestText;
  dialog.returnValue = "decline";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "allow" ? "allow" : "decline"), { once: true });
    dialog.showModal();
  });
}

function appendRequest(row) {
  const tr = get("ledger").insertRow();
  for (const value of [row.method + " " + row.destination, row.purpose,
    row.authorization || row.hasCanary || row.cookieHeader ? "Yes" : "No"]) {
    tr.insertCell().textContent = value;
  }
}

function verdict(name, r) {
  const ran = r.peers.map(p => p.name);
  if (name !== "default" && r.decisions.some(d => d.decision === "decline")) return "Declined";
  const stops = r.stops.join("\n");
  switch (name) {
    case "publish": return r.errors.length === 0 && r.agents.length === 2 && String(r.agents) === String(r.sourceAgents);
    case "default": return r.router === r.publishedRouter && r.modelCalls > 0 && r.actions.some(a => a.status === "succeeded");
    case "local": return r.agentsRun.includes("foundation/inspector") && r.actions.some(a => a.result?.check === "local");
    case "honest": return ran.join() === "honest" && r.agentsRun.includes("honest/honest");
    case "key_thief": return ran.join() === "key_thief" && r.agentsRun.includes("key_thief/key_thief") && !r.stops.length && r.peerRouters[0] !== r.router &&
      r.ledger.some(row => row.destination === caller + modelRoute + "/chat/completions" && row.hasCanary) &&
      r.ledger.filter(row => row.destination.startsWith(peerOrigin)).every(row => !row.hasCanary && !row.authorization);
    case "sly_snoop": return ran.join() === "sly_snoop" && r.peers[0].fields.join() === "lab_color";
    case "no grant": return ran.join() === "greedy,sly_snoop" && r.peers[1].fields.length === 0;
    case "broken": return !ran.length && /failed validation/.test(stops);
    case "cycle": return ran.join() === "loop_a,loop_b" && /Stopped: loop_a is already in this request's call chain \(cycle loop_a → loop_b → loop_a\)/.test(stops);
    case "depth": return ran.join() === "depth_1" && /Stopped: depth_2 was not contacted: composition depth limit \(2\) exceeded/.test(stops);
    case "remote limit": return ran.length === 4 && /limit of 4 third-party calls/.test(stops);
    case "agent limit": return r.agentsRun.length === 24 && /limit of 24 agent invocations/.test(stops);
    case "denied": return !ran.length && /Policy:/.test(stops);
    case "near_name": return !ran.length && /No published network named/.test(stops);
    case "redirector": return !ran.length && /fetch 302/.test(stops) ? "Replayed 302 stopped · live redirect 未確認" : "Unexpected redirect fixture result";
    default: return false;
  }
}

function show(name, result) {
  const observed = verdict(name, result);
  const title = document.createElement("h3");
  title.textContent = name + " · " + (typeof observed === "string" ? observed : observed ? "Observed" : "Unexpected result");
  const content = document.createElement("pre");
  const lines = [];
  if (name === "publish") lines.push("Source and build: " + result.agents.join(", "));
  if (result.modelCalls) lines.push("Model: " + result.model + " via " + result.router);
  if (result.peerRouters.length) lines.push("Peer-declared router: " + result.peerRouters.join(", "));
  if (result.agentsRun.length) lines.push("Agent invocations: " + result.agentsRun.length);
  for (const receipt of result.actions) lines.push("Site action: " + receipt.status + " · " + receipt.result?.check);
  for (const peer of result.peers) lines.push(peer.name + " received fields: " + JSON.stringify(peer.fields));
  if (name === "sly_snoop") lines.push("Upstream kernel helper: " + result.upstreamKernelKeys.join(", ") + ". Peer return propagation: 未確認.");
  if (name === "default") lines.push("Optional peer calls declined by this local check: " + result.decisions.length);
  else lines.push(...result.stops);
  content.textContent = lines.join("\n");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Invocation and consent details";
  const raw = document.createElement("pre");
  raw.textContent = JSON.stringify({ agents: result.agentsRun, receipts: result.actions, decisions: result.decisions }, null, 2);
  details.append(summary, raw);
  get("results").append(title, content, details);
}

for (const button of buttons) button.addEventListener("click", async () => {
  const choice = button.dataset.probe;
  const cases = choice === "private" ? ["sly_snoop", "no grant"] : [choice === "stops" ? get("failure").value : choice];
  get("ledger").replaceChildren();
  get("results").replaceChildren();
  for (const b of buttons) b.disabled = true;
  try {
    for (const name of cases) {
      status.textContent = "Running " + name + "…";
      const result = await runProbe(name, { caller, consent: requestConsent, onRequest: appendRequest, replayRedirect: name === "redirector" });
      show(name, result);
      if (name !== "default" && result.decisions.some(d => d.decision === "decline")) break;
    }
    status.textContent = "Run complete";
  } catch (error) { status.textContent = "Stopped · " + error.message; }
  finally { for (const b of buttons) b.disabled = false; }
});
