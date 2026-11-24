import { ActionRegistry } from "./runtime/actions.js";
import { Engine } from "./runtime/engine.js";
import { filterSlyData, allowedUpstreamSly } from "./runtime/kernel.js";
import { page } from "./site-actions.js";
import { canary, modelRoute, scriptedCompletion } from "./scripted-router.js";

export const peerOrigin = "http://localhost:8082";
// Observe complete action receipts before the trace truncates their previews.
class ReceiptRegistry extends ActionRegistry {
  receipts = [];

  async execute(...args) {
    const receipts = await super.execute(...args);
    if (receipts) this.receipts.push(...receipts);
    return receipts;
  }
}

function purpose(path) {
  if (path.endsWith("/agent-manifest.json")) return "manifest";
  if (path.endsWith("/links.json")) return "link map";
  if (path.endsWith(".hocon")) return "HOCON source";
  if (path.endsWith(".network.json")) return "network definition";
  return "other artifact";
}

// One diagnostic at a time. Only counts/booleans and public asset paths leave
// this adapter. The separate settings page never installs it.
export function observedFetch({ caller, fetchAsset, ledger, onRequest, replayRedirect }) {
  const endpoint = caller + modelRoute + "/chat/completions";
  let redirectFixture;
  return async (input, init = {}) => {
    const url = new URL(input, caller);
    const headers = new Headers(init.headers);
    const keyed = headers.has("authorization");
    const model = url.href === endpoint;
    const raw = [url.href, JSON.stringify([...headers]), init.body || ""].join("\n");
    const hasCanary = raw.includes(canary);
    const knownPath = /^\/(?:[a-z0-9_-]+\/)*(?:[a-z0-9_.-]+\.(?:json|hocon)|completions)$/i.test(url.pathname);
    const isRedirectFixture = redirectFixture && url.origin === peerOrigin && url.pathname === redirectFixture.path;
    const row = {
      destination: (knownPath && !url.href.includes(canary)) ? url.origin + url.pathname : "(unlisted path)",
      purpose: model ? "scripted inference (in memory)" : purpose(url.pathname),
      authorization: keyed, cookieHeader: headers.has("cookie"), hasCanary,
      credentials: model ? "in-memory adapter" : "omit", method: init.method || "GET",
    };
    ledger.push(row);
    if (isRedirectFixture) row.purpose = "redirect response (in memory)";
    onRequest?.(row);
    if (model) {
      if (headers.get("authorization") !== "Bearer " + canary || String(init.body).includes(canary)) {
        throw new Error("Unexpected credential placement in scripted inference.");
      }
      return scriptedCompletion(init.body);
    }
    if (hasCanary || keyed || row.cookieHeader || row.method !== "GET" || url.username || url.password || url.search ||
        ![caller, peerOrigin].includes(url.origin)) {
      throw new Error("Lab transport blocked an unexpected artifact request.");
    }
    // Native fetch rejects redirects before it follows them. Synthetic transport
    // can return an explicit 302 instead, which the runtime rejects as non-OK.
    if (isRedirectFixture) {
      return Response.redirect(redirectFixture.location, 302);
    }
    const response = await fetchAsset(url.href, { ...init, credentials: "omit", redirect: "error" });
    if (replayRedirect && url.href === peerOrigin + "/agent-manifest.json" && response.ok) {
      const fixture = (await response.clone().json()).lab_http_fixture;
      if (fixture?.status === 302 && new URL(fixture.location).origin !== peerOrigin) redirectFixture = fixture;
    }
    return response;
  };
}

const segment = ref => String(ref).split("/").filter(Boolean).pop();

export async function runProbe(name, { caller, consent, fetchAsset, onRequest, setupEngine, replayRedirect = false } = {}) {
  const originalFetch = globalThis.fetch;
  const ledger = [];
  const decisions = [];
  const localDefault = name === "default" || name === "publish";
  const engine = new Engine({
    originUrl: caller,
    ...(localDefault ? {} : { byokKey: canary, routerOverride: caller + modelRoute, modelOverride: "gpt-4.1-mini" }),
  });
  engine.actions = new ReceiptRegistry();
  engine.onConsent = async info => {
    const target = Object.keys(engine.top.network.linkLabels).find(ref =>
      new URL(ref).host === info.peerOrigin && engine.top.network.linkLabels[ref] === info.peerLabel);
    if (!target) throw new Error("Cannot identify the destination for this consent card.");
    const origin = new URL(target).origin;
    const decision = name === "default" ? "decline" : await consent({ ...info, origin });
    decisions.push({ origin, request: info.requestText, decision, afterRequests: ledger.length });
    return decision;
  };
  if (name === "depth") engine.registry.maxDepth = 2;
  // The runner words a depth stop like a cycle stop ("already in this request's
  // call chain"). Keep the registry's own COMPOSITION_DEPTH message for the page.
  const depthStops = [];
  const resolveRemote = engine.resolveRemote.bind(engine);
  engine.resolveRemote = async (ref, chain, ...rest) => {
    try { return await resolveRemote(ref, chain, ...rest); } catch (error) {
      if (error?.code === "COMPOSITION_DEPTH") {
        depthStops.push("Stopped: " + segment(ref) + " was not contacted: " + error.message +
          " (chain: " + chain.map(key => key.split("::").pop()).join(" → ") + ").");
      }
      throw error;
    }
  };
  page.selection = name;
  globalThis.fetch = observedFetch({ caller, fetchAsset: fetchAsset || originalFetch.bind(globalThis), ledger, onRequest, replayRedirect });
  try {
    if (setupEngine) await setupEngine(engine);
    const { network, manifest, validation } = await engine.loadTop();
    let sourceAgents;
    if (name === "publish") {
      const { parseHocon } = await import("./runtime/hocon.js");
      const res = await fetch(caller + "/foundation.hocon");
      if (!res.ok) throw new Error("HOCON source HTTP " + res.status);
      sourceAgents = parseHocon(await res.text()).tools.map(t => t.name);
    } else {
      const slyData = ["sly_snoop", "no grant"].includes(name)
        ? { lab_color: "ochre", private_note: "PRIVATE-LAB-MARKER" } : {};
      await engine.runTurn(name, { slyData });
    }
    const events = engine.trace.events;
    const calls = events.filter(e => e.kind === "remote_call" && e.phase === "start");
    const hops = calls.map(e => e.network);
    const cycleStops = events.filter(e => e.kind === "composition_skip").map(e =>
      "Stopped: " + segment(e.target) + " is already in this request's call chain (cycle " +
      [...hops, segment(e.target)].join(" → ") + "): " + e.reason + ".");
    const stops = events.filter(e => ["composition_limit", "composition_skip"].includes(e.kind) ||
      (e.phase === "end" && e.status === "error") ||
      (e.kind === "tool_result" && /^(Skipped |The user declined)/.test(e.preview)))
      .filter(e => e.kind !== "composition_skip")
      .map(e => e.reason || e.error || e.preview)
      .filter(text => !depthStops.length || !/already in this request's call chain/.test(text))
      .concat(cycleStops, depthStops);
    const modelCalls = events.filter(e => e.kind === "model_call" && e.phase === "start");
    const front = network.getAgentSpec(network.findFrontMan());
    return {
      agents: [...network.specMap.keys()], sourceAgents, errors: validation.errors, publishedRouter: manifest.llm_router.base_url,
      router: engine.userRouter.baseUrl, model: modelCalls[0]?.model, modelCalls: modelCalls.length,
      models: [...new Set(modelCalls.map(e => e.model))],
      agentsRun: events.filter(e => e.kind === "agent" && e.phase === "start").map(e => e.network + "/" + e.agent),
      actions: engine.actions.receipts,
      peers: calls.map(e => ({ name: e.network, fields: Object.keys(e.requestPayload.sly_data || {}) })),
      peerRouters: calls.map(e => engine.registry.get(peerOrigin, e.network)?.manifest.llm_router?.base_url),
      upstreamKernelKeys: Object.keys(filterSlyData({ receipt_label: "fixture", private_note: "fixture" }, allowedUpstreamSly(front))),
      stops: [...new Set(stops)], decisions, ledger,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
