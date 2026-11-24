// Apache-2.0. Runtime validation and the configuration it uses. See README.
import { deepMerge, isPlainObject } from "./hocon.mjs";
import { find_front_man, classify_tool } from "./graph.gen.mjs";
import { validate_network } from "./validation.gen.mjs";

// Canonicalize model identifiers entered through profiles or forms.
export function normalizeModelName(value) {
  let model = String(value ?? "").trim();
  while (model.length >= 2) {
    const first = model[0];
    const last = model[model.length - 1];
    if (!((first === '"' && last === '"') || (first === "'" && last === "'"))) break;
    model = model.slice(1, -1).trim();
  }
  return model;
}

// Expand commondefs.replacement_strings ({token}) and replacement_values, then
// push top-level defaults down onto each agent spec, mirroring DefaultsConfigFilter.
const DEFAULT_KEYS = [
  "llm_config",
  "verbose",
  "max_steps",
  "max_iterations",
  "max_execution_seconds",
  "max_attempts",
  "error_formatter",
  "error_fragments",
];

export function filterConfig(rawConfig) {
  let config = deepClone(rawConfig);
  const commondefs = config.commondefs || {};
  const strs = commondefs.replacement_strings || {};
  const vals = commondefs.replacement_values || {};

  config = walkReplace(config, (v) => {
    if (typeof v === "string") {
      // full-value replacement_values match first
      if (Object.prototype.hasOwnProperty.call(vals, v)) return vals[v];
      // {token} string substitution
      return v.replace(/\{([A-Za-z0-9_]+)\}/g, (m, key) =>
        Object.prototype.hasOwnProperty.call(strs, key) ? strs[key] : m
      );
    }
    return v;
  });

  // push down defaults
  const tools = Array.isArray(config.tools) ? config.tools : [];
  for (const agent of tools) {
    for (const key of DEFAULT_KEYS) {
      if (Object.hasOwn(config, key)) {
        if (isPlainObject(config[key]) && isPlainObject(agent[key])) {
          agent[key] = deepMerge(config[key], agent[key]);
        } else if (!Object.hasOwn(agent, key)) {
          agent[key] = deepClone(config[key]);
        }
      }
    }
    // name correction: trim whitespace
    if (typeof agent.name === "string") agent.name = agent.name.trim();
    normalizeConfiguredModel(agent.llm_config);
  }
  normalizeConfiguredModel(config.llm_config);
  return config;
}

// A blank or quoted-empty model_name ("  ", '""') becomes "", so it counts as not set
// and falls back to the network's model. Both runners and the settings panel read
// this config, so they all fall back the same way.
function normalizeConfiguredModel(llmConfig) {
  if (isPlainObject(llmConfig) && typeof llmConfig.model_name === "string") {
    llmConfig.model_name = normalizeModelName(llmConfig.model_name);
  }
}

function walkReplace(v, fn) {
  if (Array.isArray(v)) return v.map((x) => walkReplace(x, fn));
  if (isPlainObject(v)) {
    return Object.fromEntries(Object.entries(v).map(([key, value]) => [key, walkReplace(value, fn)]));
  }
  return fn(v);
}

function deepClone(v) {
  return typeof structuredClone === "function"
    ? structuredClone(v)
    : JSON.parse(JSON.stringify(v));
}

export class AgentNetwork {
  constructor(config, name) {
    this.config = filterConfig(config);
    this.name = name;
    this.linkSlots = new Set(Object.keys(this.config.link_slots || {}));
    this.specMap = new Map();
    for (const agent of this.config.tools || []) {
      if (agent && typeof agent.name === "string") this.specMap.set(agent.name, agent);
    }

  }

  // Delegates to the cross-compiled kernel (neuro_san/kernel/graph.py).
  findFrontMan() {
    return find_front_man(this.config);
  }

  // Delegates classification to the cross-compiled kernel, then attaches the
  // local agent spec (needed by the runner) for non-remote/non-mcp kinds.
  classifyTool(ref) {
    let kind = classify_tool(this.config, ref);
    if (kind === "missing" && typeof ref === "string" && this.linkSlots.has(ref)) kind = "link";
    const spec = typeof ref === "string" ? this.specMap.get(ref) : undefined;
    return { kind, ref, spec };
  }
}

export function validateNetwork(network) {
  // Errors come from the cross-compiled kernel (neuro_san/kernel/validation.py).
  const errors = validate_network(network.config).filter((message) =>
    ![...network.linkSlots].some((ref) => message.includes(`references missing tool '${ref}'.`))
  );
  const warnings = [];

  // The externals/mcps list (for the trace's cross-origin permission view) is a
  // browser-side concern, scanned here.
  const externals = [];
  const mcps = [];
  for (const agent of network.config.tools || []) {
    for (const ref of agent.tools || []) {
      const c = network.classifyTool(ref);
      if (c.kind === "remote") externals.push(ref);
      else if (c.kind === "mcp") mcps.push(typeof ref === "string" ? ref : ref.url);
    }
  }
  return { errors, warnings, externals, mcps };
}
