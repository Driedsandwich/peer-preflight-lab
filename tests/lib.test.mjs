import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fingerprint, readLock } from "../core/src/preflight-core.mjs";
import { presets } from "../lab-caller/origins.js";
import { StubDocument } from "./stub_document.mjs";
import { StubElement } from "./stub_element.mjs";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const peerOrigin = presets.public.peers;
const honest = peerOrigin + "/honest";
const tours = peerOrigin + "/tours";
const broken = peerOrigin + "/broken";
const manifestUrl = peerOrigin + "/agent-manifest.json";
const linksUrl = peerOrigin + "/links.json";
const manifest = JSON.parse(await read("lab-peers/agent-manifest.json"));
const definitionUrl = (name) => new URL(manifest.networks.find((entry) => entry.name === name).hocon, peerOrigin).href;
const demoHtml = await read("lib/demo.html");
const demoLock = await read("lib/demo.peers.lock.json");
const { peers: demoPins } = readLock(demoLock);
const pageUrl = "https://site.example/pages/embed.html";
const baseUrl = "https://site.example/assets/";
const pinPath = "./demo.peers.lock.json";
const lockUrl = new URL(pinPath, baseUrl).href;
const resultEvent = "peer-preflight:result";
const doneEvent = "peer-preflight:done";
let moduleInstances = 0;

function fixtureResponse(url, body, status = 200) {
  const response = new Response(body, { status });
  Object.defineProperties(response, { url: { value: url }, type: { value: "cors" } });
  return response;
}

async function setup(t, lock = demoLock) {
  const document = StubDocument.fromHtml(demoHtml, pageUrl);
  document.baseURI = baseUrl;
  const registry = new Map();
  const calls = [];
  const responses = new Map();
  const window = {};

  class StubHTMLElement extends StubElement {
    constructor() {
      super("peer-preflight");
      this.ownerDocument = document;
    }

    attachShadow() {
      this.shadowRoot = new StubElement("shadow");
      return this.shadowRoot;
    }

    dispatchEvent(event) {
      this.dispatch(event.type, event);
      return true;
    }
  }

  const globals = {
    document,
    window,
    HTMLElement: StubHTMLElement,
    customElements: { define: (name, constructor) => registry.set(name, constructor), get: (name) => registry.get(name) },
    async fetch(url, options) {
      calls.push({ url, options });
      if (responses.has(url)) return responses.get(url)(options);
      if (url === lockUrl) return fixtureResponse(url, lock);
      const { origin, pathname } = new URL(url);
      if (origin !== peerOrigin) throw new Error("Unexpected fetch " + url);
      return fixtureResponse(url, await read("lab-peers" + pathname));
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  for (const name of ["localStorage", "sessionStorage"]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, get() { assert.fail("Unexpected storage access"); } });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }

  await import(new URL("../lib/peer-preflight.js?test=" + ++moduleInstances, import.meta.url));
  document.provide("peer-preflight[pin]", []);
  function mount() {
    const Element = registry.get("peer-preflight");
    const element = new Element();
    const pin = demoHtml.match(/<peer-preflight pin="([^"]+)"/)[1];
    element.setAttribute("pin", pin);
    document.provide("peer-preflight[pin]", [element]);
    const events = [];
    element.addEventListener(resultEvent, (event) => events.push(event));
    const done = new Promise((resolve) => element.addEventListener(doneEvent, (event) => {
      events.push(event);
      resolve(event.detail);
    }));
    element.isConnected = true;
    element.attributeChangedCallback("pin", null, pin);
    element.connectedCallback();
    return { element, events, done };
  }
  return { api: window.peerPreflight, mount, calls, responses };
}

function assertPublicGets(calls) {
  assert.ok(calls.length > 0);
  for (const { options } of calls) {
    assert.deepEqual(options, {
      method: "GET", credentials: "omit", mode: "cors", referrerPolicy: "no-referrer",
      redirect: "error", cache: "no-store",
    });
  }
}

test("the demo renders matching and changed pins and emits one result event per peer before done", async (t) => {
  const { calls, mount } = await setup(t);
  const { element, events, done } = mount();
  const results = await done;
  const [honestResult, toursResult] = results;
  assert.deepEqual(honestResult.peer, { name: "honest", url: honest, agentCount: 1 });
  assert.deepEqual(toursResult.peer, { name: "tours", url: tours, agentCount: 3 });
  assert.deepEqual(Object.keys(honestResult), ["peer", "verdict", "findings", "changes", "fingerprint"]);
  assert.equal(honestResult.verdict, "Pass");
  assert.equal(honestResult.changes.changed, false);
  assert.equal(honestResult.fingerprint, demoPins[honest].sha256);
  assert.equal(toursResult.verdict, "Caution");
  assert.ok(toursResult.findings.some(({ id }) => id === "pin-changed"));
  const historical = JSON.parse(await read("app/demo/tours-v1.json"));
  const { manifest, network, links } = historical.snapshot;
  const before = await fingerprint({ manifest, network, links });
  assert.equal(before, historical.lock.peers[tours].sha256);
  assert.deepEqual(toursResult.changes.fingerprint, { before, after: toursResult.fingerprint, changed: true });
  assert.notEqual(toursResult.fingerprint, before);
  assert.equal(toursResult.changes.hasSnapshots, false);

  const rows = element.shadowRoot.querySelectorAll("li");
  assert.deepEqual(rows.map((row) => row.children[0]), ["honest: ", "tours: "]);
  assert.deepEqual(rows.map((row) => row.querySelector("span").textContent), ["○", "△"]);
  assert.deepEqual(rows.map((row) => row.querySelector("strong").children[1]), [" Pass", " Caution"]);
  assert.deepEqual(rows.map((row) => row.children.at(-1)), [" · Matches pin", " · Changed"]);
  assert.deepEqual(events.map(({ type }) => type), [resultEvent, resultEvent, doneEvent]);
  assert.deepEqual(events.map(({ detail }) => detail), [honestResult, toursResult, results]);
  assert.ok(events.every(({ bubbles, composed }) => bubbles && composed));
  assert.equal(calls[0].url, lockUrl);
  assert.deepEqual(calls.slice(1).map(({ url }) => url).sort(),
    [manifestUrl, manifestUrl, definitionUrl("honest"), definitionUrl("tours"), linksUrl, linksUrl].sort());
  assertPublicGets(calls);
});

test("the browser API verifies fresh publications and allows only matching pins with non-Block verdicts", async (t) => {
  const { api, calls, mount, responses } = await setup(t);
  const { done } = mount();
  const loaded = await done;
  const equivalentHonest = honest + "/?view=public#details";
  assert.deepEqual(await api.check(equivalentHonest), loaded[0]);
  assert.equal(await api.shouldAllow(equivalentHonest), true);
  assert.equal(await api.shouldAllow(tours), false);
  const previousCalls = calls.length;
  assert.equal(await api.shouldAllow(broken), false);
  assert.equal(await api.shouldAllow("not a URL"), false);
  assert.equal(calls.length, previousCalls);
  assert.equal((await api.check(broken)).verdict, "Block");

  const changed = JSON.parse(await read("lab-peers/honest/honest.network.json"));
  changed.tools[0].instructions += "\nDescribe the public probe briefly.";
  responses.set(definitionUrl("honest"), () => fixtureResponse(definitionUrl("honest"), JSON.stringify(changed)));
  const [current] = await api.verifyLock();
  assert.equal(current.verdict, "Caution");
  assert.equal(current.changes.changed, true);
  assert.notEqual(current.fingerprint, loaded[0].fingerprint);
  assert.equal(await api.shouldAllow(honest), false);
  assert.equal(calls.filter(({ url }) => url === lockUrl).length, 1);
  assertPublicGets(calls);
});

test("a matching Caution is allowed while a pinned or current Block is denied", async (t) => {
  const links = JSON.parse(await read("lab-peers/links.json"));
  async function currentDigest(name) {
    const { pathname } = new URL(definitionUrl(name));
    const network = JSON.parse(await read("lab-peers" + pathname));
    return fingerprint({ manifest, network, links: links.networks[name] ?? {} });
  }
  const lock = JSON.stringify({ version: 1, peers: {
    [honest + "/"]: { ...demoPins[honest], verdict: "Block" },
    [tours]: { ...demoPins[tours], sha256: await currentDigest("tours"), verdict: "Caution" },
    [broken]: { ...demoPins[honest], sha256: await currentDigest("broken") },
  } });
  const { api, calls, mount } = await setup(t, lock);
  const { done, element } = mount();
  const results = await done;
  assert.deepEqual(results.map(({ verdict, changes }) => [verdict, changes.changed]),
    [["Block", false], ["Block", false], ["Caution", false]]);
  assert.ok(results[0].findings.some(({ id }) => id === "network-validation"));
  assert.ok(results[1].findings.some(({ id }) => id === "pin-blocked"));
  assert.equal(element.shadowRoot.querySelector("span").textContent, "□");
  assert.equal(await api.shouldAllow(broken), false);
  assert.equal(await api.shouldAllow(honest), false);
  assert.equal(await api.shouldAllow(tours), true);
  assertPublicGets(calls);
});

test("missing and invalid locks leave the gate closed while single-peer checks still work", async (t) => {
  const { api, calls, mount } = await setup(t, '{"version":2,"peers":{}}');
  assert.deepEqual(await api.verifyLock(), []);
  assert.equal(await api.shouldAllow(honest), false);
  assert.equal(calls.length, 0);
  const { element, events } = mount();
  await assert.rejects(api.verifyLock(), /version 1 peer lock/);
  assert.deepEqual(events, []);
  assert.equal(element.shadowRoot.querySelector("p").textContent, "Could not verify the peer lock.");
  assert.equal(await api.shouldAllow(honest), false);
  assert.ok(calls.every(({ url }) => url === lockUrl));
  const result = await api.check(honest);
  assert.equal(result.verdict, "Pass");
  assert.equal(result.changes, null);
  assertPublicGets(calls);
});

test("foreign artifact URLs and redirects cannot trigger requests to other origins", async (t) => {
  const { api, calls, mount, responses } = await setup(t);
  const { done } = mount();
  await done;
  calls.length = 0;

  const foreignUrl = "https://other.example/network.json";
  const foreignManifest = {
    ...manifest,
    networks: [{ ...manifest.networks.find(({ name }) => name === "honest"), hocon: foreignUrl }],
  };
  responses.set(manifestUrl, () => fixtureResponse(manifestUrl, JSON.stringify(foreignManifest)));
  assert.equal((await api.check(honest)).verdict, "Block");
  assert.deepEqual(calls.map(({ url }) => url), [manifestUrl]);

  responses.set(manifestUrl, (options) => {
    if (options.redirect !== "error") assert.fail("The browser would follow the redirect");
    throw new TypeError("Redirect disallowed");
  });
  assert.equal((await api.check(honest)).fingerprint, null);
  assert.equal(await api.shouldAllow(honest), false);
  assert.deepEqual(calls.map(({ url }) => url), [manifestUrl, manifestUrl, manifestUrl]);
  assertPublicGets(calls);
});

test("an unreadable link map prevents approval even for a peer pinned with empty bindings", async (t) => {
  const { api, calls, mount, responses } = await setup(t);
  responses.set(linksUrl, () => fixtureResponse(linksUrl, "Unavailable", 503));
  const { done, element } = mount();
  const [result] = await done;
  assert.equal(result.verdict, "Caution");
  assert.equal(result.fingerprint, null);
  assert.equal(result.changes, null);
  assert.ok(result.findings.some(({ id }) => id === "links-unavailable"));
  assert.equal(element.shadowRoot.querySelector("li").children.at(-1), " · Version unverified");
  assert.equal(await api.shouldAllow(honest), false);
  assertPublicGets(calls);
});

test("changing the pin reloads the lock and cancels approval against the previous lock", async (t) => {
  const { api, calls, mount, responses } = await setup(t);
  const { done, element, events } = mount();
  await done;
  events.length = 0;

  const requested = Promise.withResolvers();
  const response = Promise.withResolvers();
  responses.set(manifestUrl, () => {
    requested.resolve();
    return response.promise;
  });
  const inFlight = api.shouldAllow(honest);
  await requested.promise;

  const pin = "./empty.peers.lock.json";
  const newLockUrl = new URL(pin, baseUrl).href;
  responses.set(newLockUrl, () => fixtureResponse(newLockUrl, '{"version":1,"peers":{}}'));
  const updated = new Promise((resolve) => element.addEventListener(doneEvent, (event) => resolve(event.detail)));
  element.setAttribute("pin", pin);
  element.attributeChangedCallback("pin", pinPath, pin);
  assert.deepEqual(await updated, []);
  response.resolve(fixtureResponse(manifestUrl, JSON.stringify(manifest)));
  assert.equal(await inFlight, false);
  assert.deepEqual(events.map(({ type }) => type), [doneEvent]);
  assert.equal(element.shadowRoot.querySelector("p").textContent, "No pinned peers.");
  assert.ok(calls.some(({ url }) => url === newLockUrl));
  assertPublicGets(calls);
});
