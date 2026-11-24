// Switch Peer Preflight and the lab between its public addresses and its local-test addresses.
//
//   node scripts/set_origins.mjs --public      public addresses (GitHub Pages caller, Vercel peers)
//   node scripts/set_origins.mjs --local       the loopback set, for trying the lab on this machine
//   node scripts/set_origins.mjs --check       change nothing; check the networks and update demo pin
//   add --no-build to rewrite the text only
//
// The addresses live in lab-caller/origins.js. This script rewrites every hand-written
// copy of them (HOCON sources, manifests, link maps, the redirect rules) to the chosen
// set and updates `active` in origins.js. Then it rebuilds the generated files
// (.network.json, agent-mcp.json, .well-known, bridge) with the vendored build_network.mjs
// and checks every source and the update demo pin. `broken` must fail the build: its invalid source is the point
// of that fixture. Any other result stops the script with a non-zero exit code.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildToursDemo } from "./build_tours_demo.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originsFile = path.join(root, "lab-caller", "origins.js");
const { active, presets } = await import(pathToFileURL(originsFile).href);
const builder = path.join(root, "vendor", "agentify-website", "scripts", "build_network.mjs");
const runtime = path.join(root, "lab-caller", "runtime");
const roles = ["caller", "peers", "denied"];
const expectedToFail = new Set(["broken"]);

const args = process.argv.slice(2);
const target = args.includes("--local") ? "local" : args.includes("--public") ? "public" : null;
if (args.includes("--local") && args.includes("--public")) throw new Error("Choose one of --local and --public.");
if (!target && !args.includes("--check")) {
  console.error("Usage: node scripts/set_origins.mjs --public | --local | --check [--no-build]");
  process.exit(2);
}

// Every file that carries an address by hand. Generated files are not listed:
// the build rewrites them from these.
async function sources() {
  const appHocon = "app/preflight.hocon";
  const files = [appHocon, "app/agent-manifest.json", "lab-caller/foundation.hocon", "lab-caller/agent-manifest.json", "lab-caller/links.json",
    "lab-peers/agent-manifest.json", "lab-peers/links.json", "lab-peers/_redirects"];
  const folders = (await readdir(path.join(root, "lab-peers"), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const hocons = [];
  for (const folder of folders) {
    for (const name of await readdir(path.join(root, "lab-peers", folder))) {
      const rel = "lab-peers/" + folder + "/" + name;
      if (name.endsWith(".hocon")) { files.push(rel); hocons.push(rel); }
      if (["agent-manifest.json", "links.json", "_redirects"].includes(name)) files.push(rel);
    }
  }
  return { files, hocons: [appHocon, "lab-caller/foundation.hocon", ...hocons] };
}

const { files, hocons } = await sources();

async function checkAppOrigins(set) {
  const manifest = JSON.parse(await readFile(path.join(root, "app/agent-manifest.json"), "utf8"));
  const network = await readFile(path.join(root, "app/preflight.hocon"), "utf8");
  if (manifest.peer_policy?.mode !== "closed" ||
      JSON.stringify(manifest.allowed_peers) !== JSON.stringify([set.peers]) ||
      JSON.stringify(manifest.peer_policy.deny_origins) !== JSON.stringify([set.denied]) ||
      !network.includes(set.peers + "/honest") ||
      Object.values(presets).some(other => other !== set && network.includes(other.peers + "/"))) {
    throw new Error("The app's peer addresses do not match the active preset.");
  }
}

if (target) {
  // Two passes through placeholders, so one role's new value is never rewritten as another's old one.
  const pairs = roles.flatMap((role, index) => Object.entries(presets)
    .filter(([name]) => name !== target).map(([, set]) => [set[role], "\u0000" + index + "\u0000"]))
    .sort((a, b) => b[0].length - a[0].length);
  const counts = Object.fromEntries(roles.map(role => [role, 0]));
  for (const file of files) {
    const full = path.join(root, file);
    let text = await readFile(full, "utf8");
    const before = text;
    for (const [from, mark] of pairs) {
      const n = text.split(from).length - 1;
      counts[roles[Number(mark.slice(1, -1))]] += n;
      text = text.split(from).join(mark);
    }
    roles.forEach((role, index) => { text = text.split("\u0000" + index + "\u0000").join(presets[target][role]); });
    if (text !== before) await writeFile(full, text);
  }
  let origins = await readFile(originsFile, "utf8");
  origins = origins.replace(/^export const active = "[a-z]+";$/m, `export const active = "${target}";`);
  await writeFile(originsFile, origins);
  console.log(`Addresses rewritten for "${target}". Replaced: ` + roles.map(role => `${role} ${counts[role]}`).join(", "));
}

if (args.includes("--no-build")) process.exit(0);
await checkAppOrigins(presets[target ?? active]);

function build(hocon, ...flags) {
  const dir = path.dirname(path.join(root, hocon));
  const run = spawnSync(process.execPath, [builder, path.join(root, hocon), "--manifest", path.join(dir, "agent-manifest.json"),
    "--runtime", runtime, ...flags], { encoding: "utf8" });
  return { rc: run.status, out: (run.stdout || "") + (run.stderr || "") };
}

let bad = 0;
const name = hocon => path.basename(hocon, ".hocon");
// Write the generated files first, then check that they are up to date.
if (target) {
  for (const hocon of hocons) {
    const { rc, out } = build(hocon);
    const fails = expectedToFail.has(name(hocon));
    if (fails ? rc === 0 : rc !== 0) { bad++; console.error(`build ${hocon}: unexpected exit ${rc}\n${out}`); }
  }
}
for (const hocon of hocons) {
  const { rc, out } = build(hocon, "--check");
  const fails = expectedToFail.has(name(hocon));
  const ok = fails ? rc === 1 : rc === 0;
  if (!ok) { bad++; console.error(out); }
  console.log(`check ${hocon}: exit ${rc}${fails ? " (expected to fail)" : ""}${ok ? "" : "  <-- UNEXPECTED"}`);
}
if (bad) { console.error(bad + " unexpected build result(s)."); process.exit(1); }
const peerOrigin = presets[target ?? active].peers;
if (target) await buildToursDemo(peerOrigin, { check: false });
await buildToursDemo(peerOrigin, { check: true });
console.log("check app/demo/tours-v1.json: up to date");
