import { peerOrigin } from "../lab-caller/origins.js";
import { actionControls, browserGet, checkPeer, clearLock, exportLock, saveDecision, seedDemo } from "./preflight.js";

const samples = [
  ["honest", "An exact-name handoff for a public probe."],
  ["greedy", "Exercises the lab's limits on remote and agent calls."],
  ["key_thief", "Declares its own router and asks for a dummy API key."],
  ["sly_snoop", "Asks for a private field the caller hasn't shared."],
  ["near_name", "Requests near_name when only near_name_v2 is published."],
  ["redirector", "Tests a cross-origin redirect when the host applies its rule."],
  ["broken", "References a tool that the network never defines."],
  ["loop_a", "Links to loop_b, which points back to loop_a."],
  ["depth_1", "Starts a three-network chain for the lab's depth limit."],
  ["tours", "A three-agent tour guide with an updated booking instruction."],
];

const legend = [
  ["Pass", "nothing found that should stop you"],
  ["Caution", "read the reasons before you use it"],
  ["Block", "do not let it run"],
];
const evidenceLabels = {
  agent: "Agent", line: "Line", rules: "Matched rules", fields: "Fields",
  callerOrigin: "Caller origin", declaredOrigins: "Declared router origins",
  origin: "Origin", sources: "Declared in", cycle: "Call path", errors: "Validation errors",
  before: "Pinned fingerprint", after: "Current fingerprint", error: "Fetch error",
  from: "Requested origin", to: "Final origin", resource: "File", status: "HTTP status",
};
const byId = (id) => document.getElementById(id);
const storage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
};
const form = byId("check-form");
const input = byId("peer-url");
const checkButton = form.querySelector("button");
const actionArea = byId("decision-actions");
const reasons = byId("reason-list");
const api = window.peerPreflight = { lastResult: null };
const sampleUrl = (name) => peerOrigin + "/" + name;
const shortHash = (hash) => hash.slice(0, 7);

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function shape(verdict) {
  const icon = element("span", "shape " + verdict.toLowerCase());
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function notice(id, text = "", kind = "") {
  const node = byId(id);
  node.textContent = text;
  if (kind) node.dataset.kind = kind;
  else delete node.dataset.kind;
}

function renderLegend(list) {
  for (const [verdict, meaning] of legend) {
    const item = element("li");
    const label = element("span", "legend-label " + verdict.toLowerCase());
    label.append(shape(verdict), element("strong", "", verdict));
    item.append(label, element("span", "legend-meaning", " = " + meaning));
    list.append(item);
  }
}

for (const [name, description] of samples) {
  const item = element("li");
  const button = element("button", "sample-button");
  const explanation = element("span", "sample-description", description);
  explanation.id = "sample-" + name;
  button.type = "button";
  button.textContent = name;
  button.setAttribute("aria-describedby", explanation.id);
  button.addEventListener("click", () => {
    input.value = sampleUrl(name);
    input.removeAttribute("aria-invalid");
    notice("check-status");
    checkButton.focus();
  });
  item.append(button, explanation);
  byId("sample-list").append(item);
}
renderLegend(byId("result-legend"));
renderLegend(byId("glossary-legend"));

const checkControls = [input, checkButton, byId("show-samples"), byId("try-demo"),
  ...byId("sample-list").querySelectorAll("button")];

function titleOf(finding) {
  if (finding.id === "private-field-request") {
    return "Asks for a private field without a grant: " + finding.evidence.fields.join(", ");
  }
  if (finding.id === "new-outbound-origin") return "New outbound origin: " + finding.evidence.origin;
  if (finding.id === "peer-router") return "Declares a different model router";
  return finding.title;
}

function renderReasons(findings) {
  reasons.replaceChildren();
  for (const finding of findings.filter(({ severity }) => severity !== "pass")) {
    const row = element("li");
    const details = element("details", "finding");
    const summary = element("summary");
    summary.append(element("span", "reason-title", titleOf(finding)));
    if (finding.severity === "info") {
      const description = finding.id === "peer-router" ? "The caller's router takes precedence." : finding.detail;
      summary.append(element("span", "reason-info", "Info · " + description));
    }
    const evidence = element("div", "evidence");
    evidence.append(element("p", "", finding.detail));
    const entries = Object.entries(finding.evidence);
    if (entries.length) {
      const fields = element("dl");
      for (const [key, value] of entries) {
        const readable = Array.isArray(value) ? value.join(key === "cycle" ? " → " : ", ") : value ?? "Unavailable";
        fields.append(element("dt", "", evidenceLabels[key] ?? key), element("dd", "", readable));
      }
      evidence.append(fields);
    }
    details.append(summary, evidence);
    row.append(details);
    reasons.append(row);
  }

  const passed = findings.filter(({ severity }) => severity === "pass").map(({ id, title }) =>
    id === "network-validation" ? "valid graph" : title);
  if (passed.length) {
    const row = element("li");
    const summary = element("p", "passed-checks");
    summary.append(shape("Pass"), element("strong", "", "Passed: " + passed.join(", ")));
    row.append(summary);
    reasons.append(row);
  }
}

function renderChanges({ changes, fingerprint }, demo) {
  const hashes = byId("hashes");
  const list = byId("change-list");
  const note = byId("change-note");
  hashes.replaceChildren();
  list.replaceChildren();
  note.hidden = true;
  list.hidden = true;
  hashes.hidden = !changes;
  byId("no-pin").hidden = !!changes || !fingerprint;
  byId("demo-note").hidden = !demo;
  if (!changes) {
    if (!fingerprint) {
      note.textContent = "The public files could not be read. A fingerprint is required to save a decision.";
      note.hidden = false;
    }
    return;
  }

  const { before, after } = changes.fingerprint;
  for (const [hash, label] of [[before, "Pinned fingerprint"], [after, "Current fingerprint"]]) {
    if (hashes.childNodes.length) hashes.append(element("span", "", "→"));
    const code = element("code", "", shortHash(hash));
    code.title = label + ": " + hash;
    code.setAttribute("aria-label", label + " " + shortHash(hash));
    hashes.append(code);
  }

  function changeRow(sign, text, location) {
    const row = element("li");
    row.append(element("span", "change-sign", sign), element("span", "change-text", text));
    if (location) row.title = location;
    list.append(row);
  }
  for (const { agent, added, removed } of changes.instructions) {
    for (const { line, text } of added) changeRow("+", text, agent + ", line " + line);
    for (const { line, text } of removed) changeRow("−", text, agent + ", line " + line);
  }
  for (const url of changes.destinations.added) changeRow("+", "Added destination: " + url);
  for (const url of changes.destinations.removed) changeRow("−", "Removed destination: " + url);
  list.hidden = list.childElementCount === 0;
  if (list.hidden) {
    note.textContent = !changes.hasSnapshots ? "Only a fingerprint is available for the pinned version."
      : changes.changed ? "The fingerprint changed in other published content."
      : "No changes since the pinned version.";
    note.hidden = false;
  }
}

function renderActions(check) {
  actionArea.replaceChildren();
  for (const { id, label, style, disabled } of actionControls(check.result)) {
    const button = element("button", style, label);
    button.type = "button";
    button.dataset.action = id;
    button.disabled = !!disabled;
    if (id === "review") {
      const details = [...reasons.querySelectorAll("details")];
      button.setAttribute("aria-controls", "reason-list");
      const reflectDetails = () => {
        const allOpen = details.every((item) => item.open);
        button.setAttribute("aria-expanded", String(allOpen));
        button.textContent = allOpen ? "Hide details" : label;
      };
      reflectDetails();
      for (const item of details) item.addEventListener("toggle", reflectDetails);
      button.addEventListener("click", () => {
        const open = button.getAttribute("aria-expanded") === "false";
        for (const item of details) item.open = open;
        reflectDetails();
        if (open) details[0]?.querySelector("summary").focus();
      });
    } else {
      if (disabled) button.title = "A version fingerprint is needed to save a decision.";
      button.addEventListener("click", () => {
        try {
          saveDecision(storage, check, id === "block" ? "Block" : check.result.verdict);
          const message = id === "block"
            ? "Blocked in this browser only. The decision is saved in your local peer lock."
            : "Pinned in this browser only. The next check compares against " + shortHash(check.result.fingerprint) + ".";
          const pinButton = actionArea.querySelector('[data-action="pin"]');
          if (id === "block" && pinButton) pinButton.disabled = true;
          notice("lock-status", message, "success");
        } catch {
          notice("lock-status", "Could not write to this browser's local peer lock.", "error");
        }
      });
    }
    actionArea.append(button);
  }
}

function showResult(check, demo) {
  const { result } = check;
  const state = result.verdict.toLowerCase();
  const title = byId("result-title");
  title.className = state;
  title.textContent = result.verdict;
  byId("result-shape").className = "shape " + state;
  const { name, agentCount } = result.peer;
  const count = agentCount === null ? "agent count unavailable" : agentCount + (agentCount === 1 ? " agent" : " agents");
  byId("peer-summary").textContent = name + " · " + count;
  renderReasons(result.findings);
  renderChanges(result, demo);
  renderActions(check);
  api.lastResult = result;
  byId("samples").hidden = true;
  for (const id of ["result", "changes", "decision-actions", "show-samples"]) byId(id).hidden = false;
  title.focus();
}

async function runCheck(url, { demo = false } = {}) {
  input.value = url.trim();
  input.removeAttribute("aria-invalid");
  for (const control of checkControls) control.disabled = true;
  const previousActions = [...actionArea.querySelectorAll("button:not(:disabled)")];
  for (const action of previousActions) action.disabled = true;
  notice("lock-status");
  notice("check-status", "Checking public files…");
  const request = new AbortController();
  const timeout = setTimeout(() => request.abort(), 15000);
  const fetchWithTimeout = (resource, options) => fetch(resource, { ...options, signal: request.signal });
  try {
    if (demo) {
      const response = await browserGet(fetchWithTimeout, new URL("./demo/tours-v1.json", import.meta.url));
      if (!response.ok) throw new Error("The saved tours demo could not be read.");
      await seedDemo(storage, input.value, await response.json());
    }
    const check = await checkPeer(input.value, {
      fetch: fetchWithTimeout, callerOrigin: location.origin, storage,
      onStorageError: () => notice("lock-status", "Could not read this browser's local peer lock.", "error"),
    });
    notice("check-status");
    showResult(check, demo);
  } catch (error) {
    if (demo) {
      notice("check-status", "Could not start the update demo. Check that the demo pin and browser storage are available.", "error");
    } else {
      input.setAttribute("aria-invalid", "true");
      notice("check-status", input.value ? error.message : "Enter a peer network URL or choose a sample.", "warning");
    }
  } finally {
    clearTimeout(timeout);
    for (const control of checkControls) control.disabled = false;
    for (const action of previousActions) action.disabled = false;
    if (input.hasAttribute("aria-invalid")) input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  runCheck(input.value);
});
input.addEventListener("input", () => {
  if (input.hasAttribute("aria-invalid")) notice("check-status");
  input.removeAttribute("aria-invalid");
});
byId("try-demo").addEventListener("click", () => runCheck(sampleUrl("tours"), { demo: true }));
byId("show-samples").addEventListener("click", () => {
  for (const id of ["result", "changes", "decision-actions", "show-samples"]) byId(id).hidden = true;
  byId("samples").hidden = false;
  notice("check-status");
  byId("sample-list").querySelector("button").focus();
});

byId("export-lock").addEventListener("click", () => {
  try {
    const url = URL.createObjectURL(new Blob([exportLock(storage)], { type: "application/json" }));
    const link = element("a");
    link.href = url;
    link.download = "peers.lock.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice("lock-status", "Exported peers.lock.json.", "success");
  } catch {
    notice("lock-status", "Could not export this browser's local peer lock.", "error");
  }
});
byId("clear-lock").addEventListener("click", () => {
  try {
    clearLock(storage);
    notice("lock-status", "Cleared this browser's local peer lock.", "success");
  } catch {
    notice("lock-status", "Could not clear this browser's local peer lock.", "error");
  }
});
byId("copy-snippet").addEventListener("click", async () => {
  const snippet = byId("snippet");
  try {
    await navigator.clipboard.writeText(snippet.textContent);
    notice("copy-status", "Copied.", "success");
  } catch {
    const range = document.createRange();
    range.selectNodeContents(snippet);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    notice("copy-status", "Copy the selected text with your keyboard or browser menu.", "warning");
  }
});
