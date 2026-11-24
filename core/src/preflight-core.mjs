import { parseHocon } from "../vendor/hocon.mjs";
import { AgentNetwork, validateNetwork } from "../vendor/kernel.mjs";

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const sha256Pattern = /^[a-f0-9]{64}$/i;
const verdicts = new Set(["Pass", "Caution", "Block"]);
const array = (value) => Array.isArray(value) ? value : [];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => record(value) && Object.hasOwn(value, key) ? value[key] : undefined;

function webUrl(value, base) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, base);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function artifactUrl(value, base) {
  const url = webUrl(value, base);
  if (!url || (url.protocol === "http:" && !loopback.has(url.hostname))) {
    throw new TypeError("Peer artifacts require HTTPS (HTTP is accepted on loopback).");
  }
  url.hash = "";
  return url;
}

// The runtime joins relative artifact paths to the site base, including leading slashes.
function sitePath(value, base) {
  if (!base || typeof value !== "string" || !value.trim() || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return base + (value.startsWith("/") ? "" : "/") + value;
}

export function resolvePeer(url) {
  const { origin, pathname } = artifactUrl(url);
  const path = pathname.replace(/\/+$/, "");
  const separator = path.lastIndexOf("/");
  const name = path.slice(separator + 1);
  if (!name) throw new TypeError("The peer URL must end in a network name.");
  return { base: origin + path.slice(0, separator), name };
}

async function getArtifact(fetch, requestedUrl) {
  const result = await fetch(requestedUrl, { credentials: "omit", redirect: "follow", cache: "no-store" });
  return {
    result,
    metadata: {
      requestedUrl,
      finalUrl: result.url || null,
      accessControlAllowOrigin: result.headers?.get("access-control-allow-origin") ?? null,
      status: result.status,
    },
  };
}

function requireResponse(artifact, resource) {
  if (!artifact.result.ok) {
    throw new Error(resource + " fetch failed (HTTP " + artifact.result.status + ").");
  }
}

function requireFinalUrl(metadata) {
  if (metadata.finalUrl) artifactUrl(metadata.finalUrl);
}

function parseNetwork(text) {
  try {
    return JSON.parse(text);
  } catch {
    return parseHocon(text);
  }
}

async function readPublishedLinks(fetch, base, name) {
  const requestedUrl = new URL("links.json", base).href;
  let metadata = { requestedUrl };
  try {
    const artifact = await getArtifact(fetch, requestedUrl);
    metadata = artifact.metadata;
    requireFinalUrl(metadata);
    if (metadata.status === 404 || metadata.status === 410) return { links: {}, metadata };
    requireResponse(artifact, "Link map");
    const document = await artifact.result.json();
    if (!record(document?.networks)) throw new Error("Invalid link map.");
    const links = own(document.networks, name);
    if (links !== undefined && !record(links)) throw new Error("Invalid network link bindings.");
    return { links: links ?? {}, metadata };
  } catch {
    return { links: {}, metadata: { ...metadata, unavailable: true } };
  }
}

export async function fetchPeer(url, { fetch = globalThis.fetch } = {}) {
  const { base, name } = resolvePeer(url);
  const directory = base + "/";
  const manifestArtifact = await getArtifact(fetch, new URL("agent-manifest.json", directory).href);
  requireResponse(manifestArtifact, "Manifest");
  requireFinalUrl(manifestArtifact.metadata);
  const manifest = await manifestArtifact.result.json();
  const matches = array(manifest?.networks).filter((entry) => entry?.name === name);
  if (!matches.length) throw new Error("No exact published network name matches the peer URL.");
  if (matches.length > 1) throw new Error("The manifest repeats the requested network name.");

  const networkArtifact = await getArtifact(fetch, artifactUrl(sitePath(matches[0].hocon, base)).href);
  requireResponse(networkArtifact, "Network");
  requireFinalUrl(networkArtifact.metadata);
  const body = await networkArtifact.result.text();
  let network = null;
  try {
    network = parseNetwork(body);
  } catch {
    networkArtifact.metadata.parseError = true;
  }

  const published = await readPublishedLinks(fetch, directory, name);
  const snapshot = {
    manifest,
    network,
    links: published.links,
    response: {
      base,
      name,
      manifest: manifestArtifact.metadata,
      network: networkArtifact.metadata,
      links: published.metadata,
    },
  };
  return { ...snapshot, sha256: await snapshotFingerprint(snapshot) };
}

// Emit keys directly so integer-like keys also follow lexicographic order.
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return "[" + Array.from(value, canonicalJson).join(",") + "]";
  }
  if (record(value)) {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson(value[key])
    ).join(",") + "}";
  }
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) {
    return JSON.stringify(value);
  }
  throw new TypeError("Fingerprint input must be JSON data.");
}

export async function fingerprint(obj) {
  const bytes = new TextEncoder().encode(canonicalJson(obj));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function snapshotFingerprint(snapshot) {
  if (Object.hasOwn(snapshot, "network")) {
    return fingerprint({
      manifest: snapshot.manifest ?? null,
      network: snapshot.network,
      links: snapshot.links ?? {},
    });
  }
  if (typeof snapshot.sha256 !== "string" || !sha256Pattern.test(snapshot.sha256)) {
    throw new TypeError("A snapshot must contain network data or a SHA-256 fingerprint.");
  }
  return snapshot.sha256.toLowerCase();
}

function toolRefIsValid(ref) {
  if (typeof ref === "string") return /^https?:/i.test(ref) ? !!webUrl(ref) : !!ref.trim();
  return record(ref) && !!webUrl(ref.url);
}

function validateShape(network, entry, parseError, links) {
  const errors = new Set();
  if (parseError || !record(network) || !Array.isArray(network.tools)) {
    errors.add(parseError
      ? "The network definition could not be parsed as JSON or resolved HOCON."
      : "Network must be an object with a 'tools' array.");
    return { errors, model: null };
  }

  if (network.tools.some((agent) => !record(agent))) {
    errors.add("Every agent definition must be an object.");
    return { errors, model: null };
  }

  let model;
  try {
    const config = { ...network, links: { ...network.links, ...links } };
    model = new AgentNetwork(config, entry?.name);
  } catch {
    errors.add("The runtime could not normalize the network configuration.");
    return { errors, model: null };
  }
  const agents = model.config.tools;
  if (!Array.isArray(agents) || agents.some((agent) =>
    !record(agent) || (agent.tools != null && !Array.isArray(agent.tools))
  )) {
    errors.add("Each agent's tool references must be an array.");
    return { errors, model: null };
  }

  const names = new Set();
  let safeToValidate = true;
  for (const agent of agents) {
    if (typeof agent.name !== "string" || !agent.name.trim()) {
      errors.add("Every agent must have a nonempty string name.");
      safeToValidate = false;
    } else if (names.has(agent.name)) {
      errors.add("Duplicate agent name '" + agent.name + "'.");
    }
    names.add(agent.name);
    if (agent.instructions != null && typeof agent.instructions !== "string") {
      errors.add("Agent instructions must be text.");
    }
    for (const ref of array(agent.tools)) {
      if (!toolRefIsValid(ref)) {
        errors.add("Tool references must be nonempty names or URLs, or MCP descriptors with HTTP(S) URLs.");
        safeToValidate = false;
      } else if (model.classifyTool(ref).kind === "missing") {
        const owner = typeof agent.name === "string" ? "Agent '" + agent.name + "'" : "An unnamed agent";
        errors.add(owner + " references missing tool '" + ref + "'.");
      }
    }
  }

  if (safeToValidate) {
    for (const error of validateNetwork(model).errors) errors.add(error);
  }
  const front = model.findFrontMan();
  const frontSpec = agents.find((agent) => agent.name === front);
  if (!frontSpec || typeof front !== "string" || !front.trim() || frontSpec.class || frontSpec.toolbox) {
    errors.add("No valid front agent found.");
  }
  if (entry && (!entry.front_man || entry.front_man !== front)) {
    errors.add("Manifest front_man is missing or does not match the runtime's front agent.");
  }
  return { errors, model };
}

function callCycle(model) {
  if (!model) return null;
  const graph = new Map();
  for (const agent of model.config.tools) {
    if (typeof agent.name !== "string" || agent.class || agent.toolbox) continue;
    const calls = array(agent.tools).filter((ref) =>
      ref !== agent.name && typeof ref === "string" && model.classifyTool(ref).kind === "agent"
    );
    graph.set(agent.name, calls);
  }
  const finished = new Set();
  const active = new Map();
  for (const name of graph.keys()) {
    if (finished.has(name)) continue;
    const path = [{ name, index: 0 }];
    active.set(name, 0);
    while (path.length) {
      const frame = path.at(-1);
      const ref = graph.get(frame.name)?.[frame.index++];
      if (ref === undefined) {
        finished.add(frame.name);
        active.delete(frame.name);
        path.pop();
      } else if (active.has(ref)) {
        return [...path.slice(active.get(ref)).map((step) => step.name), ref];
      } else if (!finished.has(ref)) {
        active.set(ref, path.length);
        path.push({ name: ref, index: 0 });
      }
    }
  }
  return null;
}

const takeoverRules = [
  ["ignore-prior-instructions", /\b(?:ignore|disregard|forget)\s+(?:(?:all|the|any)\s+)*(?:previous|prior|earlier|above|system)\s+(?:instructions?|rules?|prompts?|polic(?:y|ies))\b/gi],
  ["override-caller-policy", /\b(?:override|overwrite|replace|bypass|disregard|ignore)\b[^,:\r\n]{0,85}\b(?:caller(?:'s)?|calling site(?:'s)?|host(?:'s)?|system|developer)\b[^,:\r\n]{0,45}\b(?:instructions?|rules?|prompts?|polic(?:y|ies)|safeguards?)\b/gi],
  ["reveal", /\breveal\b/gi],
  ["send-key", /\b(?:send|forward|transmit|share|post)\b.{0,35}\b(?:the|your|their|visitor's|user's)\s+(?:key|token|credential)s?\b/gi],
];
const requestVerb = /\b(?:ask(?:\s+for)?|request|require|need|get|obtain|collect|retrieve|extract|access|look up|use|include|send|enter|submit|forward|give|reveal|disclose|print|provide|share|return|display|show|output|copy|list|report|post|transmit)\b/gi;
const negative = /\b(?:never|not|without|forbid|prohibit|avoid)\b[^,:]{0,24}$/i;
const apiKey = /\bapi[\s_-]*keys?\b/gi;
const privateFields = [
  ["home_address", /\b(?:home|street|mailing|postal|residential)[\s_-]+address(?:es)?\b/gi],
  ["email", /\b(?:e[\s_-]*mails?(?:[\s_-]+addresses?)?)\b/gi],
  ["phone", /\b(?:phone|telephone|mobile)[\s_-]*(?:numbers?)?\b/gi],
  ["name", /\b(?:(?:full|legal)[\s_-]+name|(?:visitor|user|customer)(?:'s)?[\s_-]+name)\b/gi],
  ["first_name", /\bfirst[\s_-]+name\b/gi],
  ["last_name", /\blast[\s_-]+name\b/gi],
  ["password", /\bpasswords?\b/gi],
  ["api_key", apiKey],
];

const snakeId = "[a-z0-9]+(?:_[a-z0-9]+)+";
const privateAdjective = "(?:private|unshared|secret|hidden|personal)";
const fillerWord = /^(?:a|an|the|any|all|every|each|some|other|others|more|or|and|of|your|their|its|these|those|such|no|other|extra|additional|more)$/i;
// Fields named in the instruction text rather than on the fixed list: [pattern, name from match].
const namedFieldRules = [
  [new RegExp("\\b(" + snakeId + ")[ \\t]+fields?\\b", "g"), (match) => match[1]],
  [new RegExp("\\b[Ff]ields?[ \\t]+(" + snakeId + ")\\b", "g"), (match) => match[1]],
  [new RegExp("\\b[Tt]he[ \\t]+(" + snakeId + ")[ \\t]+values?\\b", "g"), (match) => match[1]],
  [new RegExp("\\b" + privateAdjective + "[ \\t]+(" + snakeId + ")\\b", "gi"), (match) => match[1].toLowerCase()],
  [new RegExp("\\b(" + privateAdjective + ")((?:[ \\t-]+[a-z0-9]+){0,2})[ \\t-]+fields?\\b", "gi"), (match) => {
    const words = match[2].split(/[ \t-]+/).filter(Boolean);
    if (words.some((word) => fillerWord.test(word))) return null;
    return [match[1], ...(words.length ? words : ["field"])].join("_").toLowerCase();
  }],
];

const normalizeText = (text) => text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/[‘’]/g, "'");

// Request verbs found before a match and not negated, as lower-case strings. "required" stands for a trailing "is required".
function requestVerbs(line, match, verbs = requestVerb) {
  const prefix = line.slice(Math.max(0, match.index - 150), match.index);
  const found = [];
  for (const verb of prefix.matchAll(verbs)) {
    if (prefix.length - (verb.index + verb[0].length) > 100) continue;
    if (!negative.test(prefix.slice(0, verb.index)) && !negative.test(prefix)) found.push(verb[0].toLowerCase());
  }
  if (!found.length && !negative.test(prefix) && /^\s+(?:(?:is|are)\s+)?(?:required|needed|must be (?:provided|included|sent))\b/i
    .test(line.slice(match.index + match[0].length))) found.push("required");
  return found;
}

const requested = (line, match) => requestVerbs(line, match).length > 0;

// Contact details a visitor is normally asked for in conversation.
const contactFields = new Set(["email", "phone", "home_address", "name", "first_name", "last_name"]);
const contactVerb = new RegExp(requestVerb.source.replace("|transmit)", "|transmit|attach|pass|confirm|verify|gather|check|restate|clarify)"), "gi");
const askVerbWord = /^(?:ask(?:\s+for)?|request|require|need|get|obtain|collect|retrieve|confirm|verify|gather|check|restate|clarify|required)$/;
const sendsOutward = /^(?:include|send|forward|attach|submit|post|transmit|share|disclose|reveal|copy|pass|output|print)$/;
const outwardDestination = /^[^.;]{0,25}?\b(?:in|into|to|with)\s+(?:(?:every|each|all|any|the|your|its|a|an)\s+)*(?:[\w-]+\s+)?(?:requests?|bookings?|reservations?|partners?|downstream|upstream|payloads?|quer(?:y|ies)|urls?|https?:\/\/\S+|websites?|sites?|tools?|agents?)\b/i;
const messageKind = /\b(?:confirmation|reminder|notification|receipt|marketing|newsletter|follow-up)\s+$/i;
const privateMarked = /\b(?:private|unshared|secret|hidden)\s+(?:[\w-]+\s+){0,2}$/i;
const privateContext = /\b(?:sly[\s_-]*data|private[\s_-]+(?:context|data))\b/i;

// "ask" (visitor conversation), "outward" (value goes out) or "none" (nothing about the visitor's own data) for a contact field match.
function contactUse(clause, match) {
  const before = clause.slice(0, match.index);
  if (messageKind.test(before)) return "none";
  if (privateContext.test(clause) || privateMarked.test(before)) return "outward";
  const verbs = requestVerbs(clause, match, contactVerb);
  if (!verbs.length) return "none";
  if (verbs.some((verb) => sendsOutward.test(verb)) ||
    outwardDestination.test(clause.slice(match.index + match[0].length))) return "outward";
  if (verbs.some((verb) => askVerbWord.test(verb))) return "ask";
  return /\b(?:visitor|user|customer|guest)'s\s+(?:[\w-]+\s+)?$|\b(?:their|your)\s+(?:own\s+)?$/i.test(before) ? "outward" : "none";
}

function instructionFindings(agents, allowedFields) {
  const fields = new Set();
  for (const agent of agents) {
    for (const field of [
      ...array(agent?.allow?.to_downstream?.sly_data),
      ...array(agent?.allow?.to_upstream?.sly_data),
      ...Object.keys(agent?.function?.sly_data_output_schema?.properties ?? {}),
    ]) {
      if (typeof field === "string" && /^[\w-]+$/.test(field)) fields.add(field);
    }
  }
  const known = [...privateFields, ...Array.from(fields, (field) => [
    field, new RegExp("\\b" + field.replaceAll("_", "[ _-]") + "\\b", "gi"),
  ])];
  const allowed = new Set(allowedFields);
  const networkFields = new Set(Array.from(fields, (field) => field.toLowerCase()));
  const findings = [];
  for (const agent of agents) {
    if (typeof agent?.instructions !== "string") continue;
    for (const [index, raw] of agent.instructions.split(/\r\n?|\n/).entries()) {
      const rules = new Set();
      const denied = new Set();
      const contact = new Set();
      for (const clause of normalizeText(raw).split(/[.!?](?=\s|$)|;/)) {
        for (const [rule, pattern] of takeoverRules) {
          if (Array.from(clause.matchAll(pattern)).some((match) =>
            !negative.test(clause.slice(Math.max(0, match.index - 50), match.index))
          )) rules.add(rule);
        }
        if (Array.from(clause.matchAll(apiKey)).some((match) => requested(clause, match))) rules.add("api-key-request");
        const slyField = /\bsly[\s_-]*data\s*(?:\.\s*|\[\s*['"]?)([\w-]+)/gi;
        const explicitFields = [...clause.matchAll(slyField)];
        for (const match of explicitFields) {
          if (!allowed.has(match[1]) && requested(clause, match)) denied.add(match[1]);
        }
        const appearsOutsideSlyRef = (match) => !explicitFields.some((ref) =>
          match.index >= ref.index && match.index < ref.index + ref[0].length
        );
        for (const [pattern, nameOf] of namedFieldRules) {
          for (const match of clause.matchAll(pattern)) {
            const field = nameOf(match);
            if (!field || field === "sly_data" || allowed.has(field) || networkFields.has(field)) continue;
            if (appearsOutsideSlyRef(match) && requested(clause, match)) denied.add(field);
          }
        }
        for (const [field, pattern] of known) {
          if (allowed.has(field)) continue;
          for (const match of clause.matchAll(pattern)) {
            if (!appearsOutsideSlyRef(match)) continue;
            if (!contactFields.has(field)) {
              if (requested(clause, match)) denied.add(field);
              continue;
            }
            const use = contactUse(clause, match);
            if (use === "outward") denied.add(field);
            else if (use === "ask") contact.add(field);
          }
        }
      }
      const location = { agent: agent.name ?? null, line: index + 1 };
      if (rules.size) findings.push(finding("instruction-takeover", "block", "Instruction takeover pattern",
        "An instruction asks for policy override, disclosure, or credentials.", { ...location, rules: [...rules] }));
      const asked = [...contact].filter((field) => !denied.has(field)).sort();
      if (asked.length) findings.push(finding("asks-visitor-contact", "info", "Asks the visitor for contact details",
        "An instruction asks the visitor for contact details in conversation. Nothing is sent outward.", { ...location, fields: asked }));
      if (denied.size) findings.push(finding("private-field-request", "caution", "Private field requested",
        "An instruction requests fields outside the caller's explicit allow list.", { ...location, fields: [...denied].sort() }));
    }
  }
  return findings;
}

function finding(id, severity, title, detail, evidence) {
  return { id, severity, title, detail, evidence };
}

function selectedEntry(snapshot) {
  const entries = array(snapshot.manifest?.networks);
  const name = snapshot.response?.name;
  return name === undefined ? (entries.length === 1 ? entries[0] : undefined)
    : entries.find((entry) => entry?.name === name);
}

function declaredDestinations(snapshot, agents, resolvedLinks) {
  const { manifest, network, links, response } = snapshot;
  const base = response?.base ? response.base + "/" : response?.manifest?.requestedUrl;
  const byUrl = new Map();
  function add(value, source, onlyNew = false) {
    const url = webUrl(value, base);
    if (!url) return;
    url.hash = "";
    if (!byUrl.has(url.href)) byUrl.set(url.href, { origin: url.origin, sources: new Set() });
    else if (onlyNew) return;
    byUrl.get(url.href).sources.add(source);
  }

  for (const agent of agents) {
    const name = typeof agent?.name === "string" ? agent.name : "(unnamed)";
    const source = "Tool " + name;
    for (const ref of array(agent?.tools)) {
      if (typeof ref === "string" && /^(?:https?:\/\/|\/)/i.test(ref)) add(ref, source);
      else if (record(ref)) add(ref.url, source + " (MCP)");
    }
    add(agent?.url, source);
    if (agent?.toolbox) add(agent.args?.url, source + " (REST)");
  }
  for (const target of Object.values(own(network, "links") ?? {})) add(target, "Network links");
  for (const target of Object.values(links ?? {})) add(target, "links.json");
  for (const target of Object.values(resolvedLinks ?? {})) add(target, "Resolved network links", true);
  for (const target of array(manifest?.allowed_peers)) add(webUrl(target)?.origin, "allowed_peers");
  add(sitePath(manifest?.coded_tools?.bundle, response?.base), "Coded tool bundle");
  add(response?.network?.requestedUrl ?? sitePath(selectedEntry(snapshot)?.hocon, response?.base), "Network definition");
  return byUrl;
}

function transportFindings(response) {
  const findings = [];
  for (const resource of ["manifest", "network", "links"]) {
    const metadata = response?.[resource];
    if (!metadata) continue;
    if (metadata.unavailable) findings.push(finding("links-unavailable", "caution", "Link map unavailable",
      "Published outbound link bindings could not be read.", { resource, status: metadata.status ?? null }));
    const from = webUrl(metadata.requestedUrl)?.origin;
    const to = webUrl(metadata.finalUrl)?.origin;
    if (from && to && from !== to) findings.push(finding("cross-origin-redirect", "caution", "Cross-origin redirect",
      "The final artifact origin differs from its requested origin.", { resource, from, to }));
    if (metadata.status >= 200 && metadata.status < 300 && !metadata.accessControlAllowOrigin?.trim()) {
      findings.push(finding("missing-cors", "caution", "CORS header unavailable",
        "Access-Control-Allow-Origin is missing or unavailable to this client.", { resource, origin: to ?? from ?? null }));
    }
  }
  return findings;
}

function routerFinding(manifest, callerRouter, callerOrigin, peerBase) {
  const declared = manifest?.llm_router;
  if (!declared) return null;
  const caller = webUrl(callerRouter, callerOrigin)?.href.replace(/\/$/, "");
  const urls = [typeof declared === "string" ? declared : declared.base_url, declared.byok_router]
    .map((value) => webUrl(value, peerBase)).filter(Boolean);
  if (caller && urls.length && urls.every((url) => url.href.replace(/\/$/, "") === caller)) return null;
  return finding("peer-router", "info", "Peer router declaration",
    "The peer declares router metadata. The caller's active router takes precedence under §4.",
    { callerOrigin: webUrl(caller)?.origin ?? null, declaredOrigins: [...new Set(urls.map((url) => url.origin))].sort() });
}

export function inspect(snapshot, { allowedFields = [], callerOrigin, callerRouter } = {}) {
  const { manifest, network, response } = snapshot;
  const findings = [];
  const { model, errors } = validateShape(network, selectedEntry(snapshot), response?.network?.parseError, snapshot.links);
  const agents = model?.config.tools ?? array(network?.tools);
  if (errors.size) findings.push(finding("network-validation", "block", "Invalid network",
    "The peer failed network validation.", { errors: [...errors] }));
  else findings.push(finding("network-validation", "pass", "Network shape accepted",
    "The peer passed the runtime validator and structural checks.", {}));

  const cycle = callCycle(model);
  if (cycle) findings.push(finding("agent-cycle", "info", "Inter-agent call cycle",
    "The resolved graph contains a cycle between distinct agents.", { cycle }));
  findings.push(...instructionFindings(agents, allowedFields));

  const peerBase = response?.base ? response.base + "/" : response?.manifest?.requestedUrl;
  const router = routerFinding(manifest, callerRouter, callerOrigin, peerBase);
  if (router) findings.push(router);

  const expected = new Set([webUrl(callerOrigin)?.origin, webUrl(peerBase)?.origin]);
  const newOrigins = new Map();
  for (const { origin, sources } of declaredDestinations(snapshot, agents, model?.config.links).values()) {
    if (expected.has(origin)) continue;
    if (!newOrigins.has(origin)) newOrigins.set(origin, new Set());
    for (const source of sources) newOrigins.get(origin).add(source);
  }
  for (const origin of [...newOrigins.keys()].sort()) {
    findings.push(finding("new-outbound-origin", "caution", "New outbound origin",
      "A declared destination is outside both the caller and peer origins.", { origin, sources: [...newOrigins.get(origin)].sort() }));
  }

  const coded = manifest?.coded_tools;
  const codedAgents = agents.filter((agent) => agent?.class).map((agent) => agent.name);
  if (coded || codedAgents.length) {
    const hasDigest = typeof coded?.integrity === "string" &&
      /^sha(?:256-[A-Za-z0-9+/]{43}=|384-[A-Za-z0-9+/]{64}|512-[A-Za-z0-9+/]{86}==)$/.test(coded.integrity.trim());
    const bundle = !!webUrl(sitePath(coded?.bundle, response?.base), peerBase);
    const detail = [
      bundle ? "The manifest declares a coded tool bundle." : "Coded tool metadata or definitions have no usable bundle URL.",
      hasDigest ? "An SRI digest is declared." : "A supported SRI digest is missing.",
    ].join(" ");
    findings.push(finding("coded-tools", "caution", "Coded tools declared", detail, { bundle, hasDigest, agents: codedAgents }));
  }
  findings.push(...transportFindings(response));
  return findings;
}

function instructionLines(text) {
  return typeof text === "string" && text !== "" ? text.split(/\r\n?|\n/) : [];
}

function lineChanges(oldText, newText) {
  const before = instructionLines(oldText);
  const after = instructionLines(newText);
  let start = 0;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (start < oldEnd && start < newEnd && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const rows = oldEnd - start + 1;
  const cols = newEnd - start + 1;
  const added = [];
  const removed = [];
  if (rows === 1 || cols === 1 || rows * cols > 1_000_000) {
    for (let i = start; i < oldEnd; i++) removed.push({ line: i + 1, text: before[i] });
    for (let j = start; j < newEnd; j++) added.push({ line: j + 1, text: after[j] });
    return { added, removed };
  }

  // Longest common subsequence of the remaining lines, bounded for untrusted input.
  const lcs = new Uint32Array(rows * cols);
  for (let i = rows - 2; i >= 0; i--) {
    for (let j = cols - 2; j >= 0; j--) {
      const cell = i * cols + j;
      lcs[cell] = before[start + i] === after[start + j] ? 1 + lcs[cell + cols + 1]
        : Math.max(lcs[cell + cols], lcs[cell + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows - 1 || j < cols - 1) {
    const cell = i * cols + j;
    if (i < rows - 1 && j < cols - 1 && before[start + i] === after[start + j]) {
      i++;
      j++;
    } else if (j === cols - 1 || (i < rows - 1 && lcs[cell + cols] >= lcs[cell + 1])) {
      removed.push({ line: start + i + 1, text: before[start + i] });
      i++;
    } else {
      added.push({ line: start + j + 1, text: after[start + j] });
      j++;
    }
  }
  return { added, removed };
}

function snapshotConfig(snapshot) {
  return validateShape(snapshot.network, selectedEntry(snapshot), false, snapshot.links).model?.config;
}

function agentInstructions(agents) {
  return new Map(agents.filter((agent) => typeof agent?.name === "string").map((agent) => [agent.name, agent.instructions]));
}

function toolInventory(agents) {
  const tools = new Map();
  for (const agent of agents) {
    if (typeof agent?.name !== "string") continue;
    for (const tool of array(agent.tools)) {
      const entry = { agent: agent.name, tool };
      tools.set(canonicalJson(entry), entry);
    }
    if (agent.class || agent.toolbox) {
      const entry = { agent: null, tool: agent.name, definition: agent };
      tools.set(canonicalJson(entry), entry);
    }
  }
  return tools;
}

function inventoryDiff(before, after) {
  const difference = (left, right) => [...left.keys()].sort()
    .filter((key) => !right.has(key)).map((key) => left.get(key));
  return { added: difference(after, before), removed: difference(before, after) };
}

export async function diff(pinnedSnapshot, currentSnapshot) {
  const [before, after] = await Promise.all([snapshotFingerprint(pinnedSnapshot), snapshotFingerprint(currentSnapshot)]);
  const fingerprint = { before, after, changed: before !== after };
  const instructions = [];
  let tools = { added: [], removed: [] };
  let destinations = { added: [], removed: [] };
  const hasSnapshots = Object.hasOwn(pinnedSnapshot, "network") && Object.hasOwn(currentSnapshot, "network");
  if (hasSnapshots) {
    const oldConfig = snapshotConfig(pinnedSnapshot);
    const newConfig = snapshotConfig(currentSnapshot);
    const oldAgents = oldConfig?.tools ?? array(pinnedSnapshot.network?.tools);
    const newAgents = newConfig?.tools ?? array(currentSnapshot.network?.tools);
    const oldSources = agentInstructions(array(pinnedSnapshot.network?.tools));
    const newSources = agentInstructions(array(currentSnapshot.network?.tools));
    const oldInstructions = agentInstructions(oldAgents);
    const newInstructions = agentInstructions(newAgents);
    const names = new Set([...oldSources.keys(), ...newSources.keys(), ...oldInstructions.keys(), ...newInstructions.keys()]);
    for (const agent of [...names].sort()) {
      const published = lineChanges(oldSources.get(agent), newSources.get(agent));
      const resolved = lineChanges(oldInstructions.get(agent), newInstructions.get(agent));
      if (published.added.length || published.removed.length) instructions.push({ agent, ...published });
      else if (resolved.added.length || resolved.removed.length) instructions.push({ agent, ...resolved });
    }
    tools = inventoryDiff(toolInventory(oldAgents), toolInventory(newAgents));
    const keepUrls = (entries) => new Map(Array.from(entries.keys(), (url) => [url, url]));
    destinations = inventoryDiff(keepUrls(declaredDestinations(pinnedSnapshot, oldAgents, oldConfig?.links)),
      keepUrls(declaredDestinations(currentSnapshot, newAgents, newConfig?.links)));
  }

  const changed = fingerprint.changed || [tools, destinations, ...instructions]
    .some(({ added, removed }) => added.length || removed.length);
  return { changed, fingerprint, instructions, tools, destinations, hasSnapshots };
}

export function verdict(findings, comparison) {
  if (findings.some(({ severity }) => severity === "block")) return "Block";
  if (comparison?.changed || findings.some(({ severity }) => severity === "caution")) return "Caution";
  return "Pass";
}

function validateLock(lock) {
  if (!record(lock) || lock.version !== 1 || !record(lock.peers)) {
    throw new TypeError("Expected a version 1 peer lock with a peers object.");
  }
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  return {
    version: 1,
    peers: Object.fromEntries(Object.keys(lock.peers).sort().map((url) => {
      const pin = lock.peers[url];
      resolvePeer(url);
      if (!record(pin) || typeof pin.sha256 !== "string" || !sha256Pattern.test(pin.sha256) ||
          typeof pin.pinned_at !== "string" || !iso.test(pin.pinned_at) || !Number.isFinite(Date.parse(pin.pinned_at)) ||
          !verdicts.has(pin.verdict)) {
        throw new TypeError("Invalid peer lock entry.");
      }
      return [url, { sha256: pin.sha256.toLowerCase(), pinned_at: pin.pinned_at, verdict: pin.verdict }];
    })),
  };
}

export function readLock(text) {
  return validateLock(JSON.parse(text));
}

export function writeLock(lock) {
  return JSON.stringify(validateLock(lock), null, 2) + "\n";
}
