import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { runProbe, peerOrigin } from "../lab-caller/probe.js";
import { callerBase, callerOrigin, deniedOrigin } from "../lab-caller/origins.js";
import { canary, modelRoute } from "../lab-caller/scripted-router.js";
import { allowedUpstreamSly, filterSlyData } from "../lab-caller/runtime/kernel.js";
import { RemoteRegistry } from "../lab-caller/runtime/remote.js";
import { selectTopRouter } from "../lab-caller/runtime/engine.js";

register("./action-loader.mjs", import.meta.url);
// Every address comes from lab-caller/origins.js, so these tests pass for either set
// of addresses that scripts/set_origins.mjs has written into the fixtures.
const caller = callerBase;
const host = origin => new URL(origin).host;
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
globalThis.location = new URL(caller + "/lab.html");
const assets = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, assets), "utf8");

async function fromDisk(input, options, peerFolder = "") {
  const url = new URL(input);
  assert.ok([callerOrigin, peerOrigin].includes(url.origin));
  let file;
  if (url.origin === callerOrigin) {
    // The caller may sit under a path prefix. Anything outside it is a 404, as on a real host.
    const prefix = new URL(caller).pathname.replace(/\/$/, "");
    if (!url.pathname.startsWith(prefix + "/")) return new Response("Missing lab fixture", { status: 404 });
    file = "lab-caller" + url.pathname.slice(prefix.length);
  } else {
    file = "lab-peers" + peerFolder + url.pathname;
  }
  try {
    return new Response(await read(file));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return new Response("Missing lab fixture", { status: 404 });
  }
}

async function probe(name, options = {}) {
  const contexts = [];
  const result = await runProbe(name, {
    caller, consent: async () => "allow", fetchAsset: fromDisk, ...options,
    setupEngine(engine) {
      options.setupEngine?.(engine);
      // Inspect the actual receiving invocation as well as its redacted trace.
      const make = engine._makeCtx.bind(engine);
      engine._makeCtx = args => {
        if (!args.isTop) contexts.push({ peer: args.network.name, sly: { ...args.slyData } });
        return make(args);
      };
    },
  });
  for (const row of result.ledger) {
    assert.doesNotMatch(JSON.stringify(row), new RegExp(canary));
    if (row.purpose.startsWith("scripted inference")) {
      assert.equal(row.destination, caller + modelRoute + "/chat/completions");
      assert.equal(row.authorization, true);
      assert.equal(row.hasCanary, true);
    } else {
      assert.equal(row.authorization, false);
      assert.equal(row.hasCanary, false);
      assert.equal(row.cookieHeader, false);
      assert.equal(row.method, "GET");
    }
  }
  for (const ctx of contexts) {
    assert.equal(Object.hasOwn(ctx.sly, "private_note"), false);
    for (const field of Object.keys(ctx.sly)) assert.equal(field, "lab_color");
  }
  assert.equal(contexts.length, result.peers.length);
  return { ...result, contexts };
}

const peerRows = r => r.ledger.filter(row => row.destination.startsWith(peerOrigin + "/"));
const stop = (r, pattern) => assert.match(r.stops.join("\n"), pattern);

test("manifest and HOCON publish the same two agents as the validated build", async () => {
  const r = await probe("publish");
  assert.deepEqual(r.agents, ["foundation", "inspector"]);
  assert.deepEqual(r.sourceAgents, r.agents);
  assert.deepEqual(r.errors, []);
});

test("published browser mock completes a local turn on the front agent's model", async () => {
  const r = await probe("default");
  assert.equal(r.router, "browser://mock");
  assert.equal(r.publishedRouter, r.router);
  assert.deepEqual(r.models, ["gpt-4.1-nano"]);
  assert.deepEqual(r.agentsRun, ["foundation/foundation", "foundation/inspector"]);
  assert.ok(r.actions.some(action => action.result.check === "default"));
  assert.equal(peerRows(r).length, 0);
  assert.ok(r.modelCalls > 0);
});

test("the scripted model delegates to the specialist and obtains the live page read receipt", async () => {
  const r = await probe("local");
  assert.deepEqual(r.agentsRun, ["foundation/foundation", "foundation/inspector"]);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].status, "succeeded");
  assert.deepEqual(r.actions[0].result, { check: "local" });
});

test("honest waits for consent before any peer GET, then executes in the caller", async () => {
  let allow, show;
  const card = new Promise(resolve => { show = resolve; });
  const pending = new Promise(resolve => { allow = resolve; });
  const contacts = [];
  const running = probe("honest", {
    consent: info => { show(info); return pending; },
    fetchAsset: (...args) => { contacts.push(args[0]); return fromDisk(...args); },
  });
  const info = await card;
  try {
    assert.equal(info.peerOrigin, host(peerOrigin));
    assert.equal(info.requestText, "public sample");
    assert.ok(contacts.every(url => !url.startsWith(peerOrigin)));
  } finally { allow("allow"); }
  const r = await running;
  assert.deepEqual(r.peers.map(p => p.name), ["honest"]);
  assert.deepEqual(r.agentsRun, ["foundation/foundation", "honest/honest"]);
  assert.ok(peerRows(r).some(row => row.destination.endsWith("honest.network.json")));
});

test("declining the card sends zero peer requests", async () => {
  const r = await probe("honest", { consent: async () => "decline" });
  stop(r, /user declined/);
  assert.deepEqual(peerRows(r), []);
  assert.deepEqual(r.peers, []);
});

test("key_thief's own manifest and model prompt cannot select the caller's router", async () => {
  let engine;
  const r = await probe("key_thief", {
    setupEngine: value => { engine = value; },
    fetchAsset: (url, init) => fromDisk(url, init, "/key_thief"),
  });
  assert.ok(!JSON.stringify(engine.trace.events).includes(canary));
  assert.ok(!JSON.stringify(engine.history).includes(canary));
  assert.deepEqual(r.peerRouters, [peerOrigin + "/unused-router/v1"]);
  assert.deepEqual(r.agentsRun, ["foundation/foundation", "key_thief/key_thief"]);
  assert.equal(r.router, caller + modelRoute);
  assert.deepEqual(r.models, ["gpt-4.1-mini"]);
  assert.ok(r.ledger.filter(row => row.authorization).length >= 3);
  assert.ok(r.ledger.every(row => !row.destination.includes("/unused-router")));
});

test("sly_snoop receives exactly the named field from the published caller", async () => {
  const r = await probe("sly_snoop");
  assert.deepEqual(r.contexts, [{ peer: "sly_snoop", sly: { lab_color: "ochre" } }]);
  assert.deepEqual(r.peers, [{ name: "sly_snoop", fields: ["lab_color"] }]);
});

test("a second hop without a downstream grant gives the same snoop an empty context", async () => {
  const r = await probe("no grant");
  assert.deepEqual(r.contexts, [{ peer: "greedy", sly: { lab_color: "ochre" } }, { peer: "sly_snoop", sly: {} }]);
});

test("upstream kernel helper selects named fields and defaults to none", async () => {
  const front = JSON.parse(await read("lab-caller/foundation.network.json")).tools[0];
  const returned = { receipt_label: "example", private_note: "private" };
  assert.deepEqual(filterSlyData(returned, allowedUpstreamSly(front)), { receipt_label: "example" });
  assert.deepEqual(filterSlyData(returned, allowedUpstreamSly({})), {});
});

test("broken fails structural validation before starting a peer agent", async () => {
  const r = await probe("broken");
  stop(r, /failed validation.*missing tool 'missing_member'/);
  assert.deepEqual(r.peers, []);
});

test("near_name refuses the only similar export in its standalone manifest", async () => {
  const r = await probe("near_name", { fetchAsset: (url, init) => fromDisk(url, init, "/near_name") });
  stop(r, /No published network named 'near_name'/);
  assert.equal(peerRows(r).length, 1);
  assert.deepEqual(r.peers, []);
});

test("loop_a reaches loop_b and the active ancestor is omitted from its tool table", async () => {
  const r = await probe("cycle");
  assert.deepEqual(r.peers.map(p => p.name), ["loop_a", "loop_b"]);
  stop(r, /already visited/);
  assert.equal(peerRows(r).filter(row => row.destination.endsWith("loop_a.network.json")).length, 1);
});

test("registry maxDepth stops depth_2 in a chain of distinct networks before its artifact is fetched", async () => {
  const r = await probe("depth");
  assert.deepEqual(r.peers.map(p => p.name), ["depth_1"]);
  assert.ok(peerRows(r).every(row => !row.destination.endsWith("depth_2.network.json")));
  stop(r, /Stopped: depth_2 was not contacted: composition depth limit \(2\) exceeded \(chain: foundation → depth_1\)\./);
  assert.doesNotMatch(r.stops.join("\n"), /already visited|cycle/);
});

test("depth_1, depth_2 and depth_3 never repeat, so the depth limit is the only guard that can stop them", async () => {
  const r = await probe("depth", { setupEngine: engine => { engine.registry.maxDepth = 5; } });
  assert.deepEqual(r.peers.map(p => p.name), ["depth_1", "depth_2", "depth_3"]);
  assert.deepEqual(r.stops, []);
});

test("the default registry rejects the sixth level and gives distinct cycle and depth codes", () => {
  const registry = new RemoteRegistry();
  const chain = Array.from({ length: 5 }, (_, n) => peerOrigin + "::n" + n);
  registry.checkCycle(chain.slice(0, 4), peerOrigin, "next");
  assert.throws(() => registry.checkCycle(chain, peerOrigin, "next"), { code: "COMPOSITION_DEPTH" });
  assert.throws(() => registry.checkCycle(chain, peerOrigin, "n0"), { code: "COMPOSITION_CYCLE" });
});

test("greedy exhausts the real shared four-call budget before a fifth distinct network", async () => {
  const r = await probe("remote limit");
  assert.deepEqual(r.peers.map(p => p.name), ["greedy", "honest", "sly_snoop", "near_name_v2"]);
  stop(r, /limit of 4 third-party calls/);
  assert.ok(peerRows(r).every(row => !row.destination.endsWith("key_thief.network.json")));
});

test("greedy reaches exactly 24 agent invocations and skips the next one", async () => {
  const r = await probe("agent limit");
  assert.equal(r.agentsRun.length, 24);
  assert.deepEqual(r.peers.map(p => p.name), ["greedy"]);
  stop(r, /limit of 24 agent invocations/);
});

test("deny_origins refuses the request even when the user allows the card", async () => {
  const r = await probe("denied");
  assert.equal(r.decisions[0].decision, "allow");
  stop(r, /Policy:.*refusing to contact/);
  assert.ok(r.ledger.every(row => !row.destination.startsWith(deniedOrigin)));
  assert.deepEqual(r.peers, []);
});

test("redirector's 302 is rejected and nothing follows its Location", async () => {
  const [path, dest, status] = (await read("lab-peers/_redirects")).trim().split(/\s+/);
  let redirects = 0;
  const later = [];
  const r = await probe("redirector", { fetchAsset: async (url, init) => {
    if (redirects) later.push(url);
    if (url === peerOrigin + path) {
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      redirects++;
      return Response.redirect(dest, Number(status));
    }
    return fromDisk(url, init);
  } });
  assert.equal(redirects, 1);
  assert.deepEqual(later, []);
  stop(r, /fetch 302/);
  assert.deepEqual(r.peers, []);
});

test("publisher-funded configuration selects the site endpoint without a key and upgrades BYOK", () => {
  const m = { llm_router: { mock: false, publisher_funded: true, base_url: caller + "/paid", byok_router: caller + modelRoute } };
  assert.equal(selectTopRouter(m, "", "").publisherFunded, true);
  assert.equal(selectTopRouter(m, m.llm_router.base_url, canary).baseUrl, m.llm_router.byok_router);
});

test("the collection serves the same network files as the individual fixture manifests", async () => {
  const catalog = JSON.parse(await read("lab-peers/agent-manifest.json"));
  assert.equal(catalog.networks.length, 13);
  for (const entry of catalog.networks) {
    const folder = entry.hocon.split("/")[1];
    const fixture = JSON.parse(await read("lab-peers/" + folder + "/agent-manifest.json"));
    assert.deepEqual(fixture.networks, [{ ...entry, hocon: "./" + entry.hocon.split("/").at(-1) }]);
    assert.ok((await read("lab-peers/" + entry.hocon)).length);
  }
  const fixture = catalog.lab_http_fixture;
  assert.equal([fixture.path, fixture.location, fixture.status].join(" "), (await read("lab-peers/_redirects")).trim());
});

// The text the visitor reads in Run evidence for each failure choice.
const shown = {
  broken: /failed validation.*missing tool 'missing_member'/,
  cycle: /Stopped: loop_a is already in this request's call chain \(cycle loop_a → loop_b → loop_a\): already visited in this request\./,
  depth: /Stopped: depth_2 was not contacted: composition depth limit \(2\) exceeded \(chain: foundation → depth_1\)\./,
  "remote limit": /Skipped Key Thief: the per-query limit of 4 third-party calls was reached/,
  "agent limit": /limit of 24 agent invocations/,
  denied: new RegExp("Policy: " + escaped(host(deniedOrigin)) + " is not in foundation's allowed_peers; refusing to contact it\\."),
  near_name: /No published network named 'near_name'/,
  redirector: /fetch 302/,
};

test("all seven HTML buttons render runtime observations, including each failure choice", async () => {
  const { StubDocument } = await import("./stub_document.mjs");
  const { StubElement } = await import("./stub_element.mjs");
  const html = await read("lab-caller/lab.html");
  const doc = StubDocument.fromHtml(html, location.href);
  const buttons = [...html.matchAll(/<button data-probe="([^"]+)"/g)].map(([, name]) => {
    const button = new StubElement("button");
    button.dataset.probe = name;
    return button;
  });
  assert.deepEqual(buttons.map(b => b.dataset.probe), ["publish", "default", "local", "honest", "key_thief", "private", "stops"]);
  doc.provide("[data-probe]", buttons);
  const ledger = doc.getElementById("ledger");
  ledger.insertRow = () => {
    const row = ledger.appendChild(new StubElement("tr"));
    row.insertCell = () => row.appendChild(new StubElement("td"));
    return row;
  };
  const dialog = doc.getElementById("consent");
  dialog.showModal = () => {
    dialog.returnValue = "allow";
    dialog.dispatch("close");
  };
  const nativeFetch = globalThis.fetch;
  globalThis.document = doc;
  globalThis.fetch = fromDisk;
  try {
    await import("../lab-caller/lab.js");
    const failures = [...html.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
    for (const button of buttons) {
      for (const selected of button.dataset.probe === "stops" ? failures : [""]) {
        doc.getElementById("failure").value = selected;
        await button.handlers.click[0]();
        const status = doc.getElementById("status").textContent;
        assert.equal(status, "Run complete", status);
        const rendered = doc.getElementById("results").children.filter(c => c.tag === "h3");
        assert.equal(rendered.length, button.dataset.probe === "private" ? 2 : 1);
        for (const heading of rendered) assert.match(heading.textContent, / · (Observed$|Replayed 302 stopped)/);
        if (button.dataset.probe === "stops") {
          const evidence = doc.getElementById("results").children.filter(c => c.tag === "pre")[0].textContent;
          assert.match(evidence, shown[selected], selected + ": " + evidence);
        }
        assert.ok(ledger.children.length > 0);
        assert.equal(button.disabled, false);
      }
    }
  } finally {
    delete globalThis.document;
    globalThis.fetch = nativeFetch;
  }
});

test("a completed peer invocation returns its answer without a private-context envelope", async () => {
  let reply;
  await probe("sly_snoop", {
    setupEngine(engine) {
      const resolve = engine.resolveRemote.bind(engine);
      engine.resolveRemote = async (...args) => {
        const session = await resolve(...args);
        const invoke = session.invoke.bind(session);
        session.invoke = async (...invocation) => {
          reply = await invoke(...invocation);
          return reply;
        };
        return session;
      };
    },
  });
  assert.equal(reply.text, "End of scripted probe.");
  assert.equal(Object.hasOwn(reply, "sly_data"), false);
  assert.ok(!JSON.stringify(reply).includes("PRIVATE-LAB-MARKER"));
  assert.ok(!JSON.stringify(reply).includes("ochre"));
});
