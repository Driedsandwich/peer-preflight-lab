import { readFile, writeFile } from "node:fs/promises";
import { fetchPeer, inspect, verdict, writeLock } from "../core/src/preflight-core.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

export async function buildToursDemo(peerOrigin, { check }) {
  const peer = peerOrigin + "/tours";
  const manifest = await read("lab-peers/agent-manifest.json");
  const entry = JSON.parse(manifest).networks.find(({ name }) => name === "tours");
  const definition = new URL(entry.hocon, peerOrigin).href;
  // Use the collection's publication paths and substitute the historical definition.
  const files = new Map([
    [peerOrigin + "/agent-manifest.json", manifest],
    [definition, await read("lab-peers/tours/_history/v1/tours.hocon")],
    [peerOrigin + "/links.json", await read("lab-peers/links.json")],
  ]);
  const snapshot = await fetchPeer(peer, {
    async fetch(url) {
      if (!files.has(url)) throw new Error("Unexpected historical artifact " + url);
      return new Response(files.get(url), { headers: { "Access-Control-Allow-Origin": "*" } });
    },
  });
  const oldVerdict = verdict(inspect(snapshot));
  if (oldVerdict !== "Pass") throw new Error("The historical tours network must pass.");

  const lock = JSON.parse(writeLock({ version: 1, peers: {
    [peer]: { sha256: snapshot.sha256, pinned_at: "2026-01-01T00:00:00Z", verdict: oldVerdict },
  } }));
  const { manifest: oldManifest, network, links, response } = snapshot;
  const historical = {
    manifest: oldManifest, network, links,
    response: { base: response.base, name: response.name, network: { requestedUrl: definition } },
  };
  const output = "app/demo/tours-v1.json";
  const generated = JSON.stringify({ lock, snapshot: historical }, null, 2) + "\n";
  if (check) {
    if (await read(output) !== generated) throw new Error(output + " is stale. Rebuild with set_origins.");
  } else {
    await writeFile(new URL(output, root), generated);
  }
}
