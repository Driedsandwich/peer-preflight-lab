# Peer Preflight

Peer Preflight checks another site's public agent files and compares the current
fingerprint with a version saved in your browser. The assistant explains the
verdict, evidence and changes, can ask sample networks to run a public probe,
and can review changes to your browser's lock.

The published network address for the repository's Pages layout is
`https://driedsandwich.github.io/peer-preflight-lab/app/preflight`. It is a
logical network address. Callers fetch `app/agent-manifest.json` from the
containing folder and choose the exact export `preflight`.

## Capabilities

| Data or operation | Where it comes from | Assistant action and effect |
| --- | --- | --- |
| A peer's public exact-name manifest entry, definition, links and fingerprint | [Preflight rules](preflight.js) and [core](../core/src/preflight-core.mjs) | `check_peer`, read. Runs a fresh inspection without replacing the page's result. |
| The result on screen, sample links, privacy text and local lock count/version | [Page state](app.js), [page](index.html) and [samples](preflight.js) | `read_result`, read. Returns a copy. |
| The browser's pinned version and associated comparison snapshot | [Page save operation](app.js) and [lock storage](preflight.js) | `pin_version`, write. Reviews the URL, verdict and fingerprint before saving. |
| The browser's recorded block | [Page save operation](app.js) and [lock storage](preflight.js) | `block_peer`, write. Reviews the same details. Future checks in this browser report the block. |
| The portable version 1 lock | [Page download operation](app.js) and [lock serializer](preflight.js) | `export_lock`, write. Reviews and downloads `peers.lock.json`. |
| Remove saved decisions and snapshots | [Page clear operation](app.js) and [review dialog](site.js) | `clear_lock`, irreversible. Reviews the current number of saved decisions and refuses a stale lock version. |
| Guided explanation | [Network source](preflight.hocon) | Front agent `preflight` calls the internal `explain_findings` agent with evidence to explain. |
| Inference and composition | [Manifest](agent-manifest.json), [mount](site.js) and [sample collection](../lab-peers/agent-manifest.json) | The visitor chooses a CORS-enabled model provider. Each sample network runs on the active caller router. |

A later pin can replace a saved pin. Clearing is required to remove a saved
block. The portable export contains fingerprints and decisions. Clearing
deletes the saved comparison snapshots too. A check cannot certify a network
as safe, modify another site's publication, or enforce a lock beyond this
page's checks. The current page result is also available as
`window.peerPreflight.lastResult`.

**Check** reads the peer's public files with credential-free GETs. No model
runs and there is no model charge. The browser sends the page's origin on
cross-origin requests for CORS. Pin and Block are saved in this browser.

**Assistant** sends the visitor's messages and any page data it reads to the
model provider the visitor selects. Its initial provider and model are hosted
Otari and `alibaba/qwen3.8-flash`. A provider key is required for model calls.
When finished with a saved setup, use **Delete setup** in AI model settings
and close the tab.

## For calling sites

When another site calls Peer Preflight, the network executes in the calling
site's visitor's browser. Its **only shared site action** is
`website_check_peer`. It runs from a hidden frame on the Peer Preflight
origin and reads the target's public manifest, network and links with
credential-free GETs. The target must permit the browser to read its public
files. The check uses the frame's origin for CORS and applies the same rules
as a fresh check with an empty lock. The bridge has no access to the open
Peer Preflight page, its current result, or this browser's saved decisions.
It shares no downloads or writes. The read can return a verdict and
fingerprint with a shortened explanation if the evidence exceeds the
runtime's receipt limit.

A calling site's visitor also sees the runtime consent card when this
network requests contact with a sample on a third-party origin. The visitor
pays for inference on their selected model. There is no public HTTP or MCP
facade for executing the network.

## Linked sample networks

The [public sample collection](../lab-peers/agent-manifest.json) is the sole
allowed peer origin. The network offers Honest for a public response,
Broken for validation, Loop A and Loop B for cycle and denied-origin
probes, Depth 1 for nested depth, Greedy for turn budgets, Key Thief for
router isolation, Sly Snoop for private-context isolation, Near Name for
exact-name matching, and Redirector for its configured artifact path.
These are project-owned fixtures. Honest has no site actions or downstream
tools and answers from its instructions. Loop B can request the denied
fixture to demonstrate the per-hop policy stop.

The request is a short public probe. The peer receives its full text.
Peer Preflight shares no private-context fields or chat history with
these networks. The card displays up to 140 characters and an estimate
for the request. The model's tool definitions and replies can add to its
cost. **Always allow** is a visitor choice remembered by host for the
tab. The supplied runtime determines third-party status relative to the
network making the hop. Same-origin nested calls share the already
contacted peer origin.

The caller has a 16-step model limit per agent, with shared per-turn limits
of four remote calls, one call per peer network, 24 agent invocations
and a 90-second deadline checked at invocation boundaries. The Depth 1
probe uses the lab's two-level limit, counting the caller, and the
runtime's default limit of five applies elsewhere. The app displays
associated stop reasons below its assistant heading. The limit stops
new calls. It does not terminate an asset fetch already waiting for a
response. The runtime follows ordinary redirects for remote public
artifacts subject to browser CORS. A real cross-origin redirect has
not been checked on the public hosts.

The runtime exposes the local action catalog to both agents. The
explainer's instructions limit its job to reading and explaining results.
The page wraps all assistant lock writes and downloads in its own
review before acting.

## Run locally

Use Node 22 or newer and run from the repository root. Change the addresses
and rebuild before opening either site.

```sh
node scripts/set_origins.mjs --local
```

For the local interoperability check, stage a copy of the app and its shared
source. This puts the app manifest at the server root so the vendored server
can discover the public files and attach CORS headers.

```sh
stage=$(mktemp -d)
mkdir -p "$stage/site/lab-caller" "$stage/checker/scripts"
cp -R app/. "$stage/site/"
cp -R core "$stage/site/core"
cp lab-caller/origins.js "$stage/site/lab-caller/"
cp vendor/agentify-website/scripts/check_partner.mjs "$stage/checker/scripts/"
ln -s "$PWD/app/runtime" "$stage/checker/runtime"
node vendor/agentify-website/scripts/serve_site.mjs "$stage/site" --port 8081 &
caller_pid=$!
```

In a second terminal, serve the samples on their own host name. The different
host names keep the runtime's loopback BYOK cookies separate.

```sh
node vendor/agentify-website/scripts/serve_site.mjs lab-peers --port 8082 --open-as localhost
```

Open `http://127.0.0.1:8081/`. In the first shell with the same `stage`
variable, run the checker commands once the caller server is in the
background. The staged checker uses the exact vendored script. Its imports
point to the unchanged runtime because the vendored skill has no
`runtime/` directory.

```sh
node "$stage/checker/scripts/check_partner.mjs" http://127.0.0.1:8081/preflight
node "$stage/checker/scripts/check_partner.mjs" http://localhost:8082/honest --origin http://127.0.0.1:8081
```

For a same-origin check of the repository layout, stop the staged server
with `kill "$caller_pid"`, then run
`node vendor/agentify-website/scripts/serve_site.mjs . --port 8081` and open
`http://127.0.0.1:8081/app/`. When finished, stop the servers and run
`node scripts/set_origins.mjs --public` from the repo root.
`node scripts/set_origins.mjs --check` verifies the active addresses,
generated files and update demo pin.

## Check without a key

Open the staged app in a browser. Click **honest** in the sample list, then
**Pin this version** to give the clear dialog a saved entry. In DevTools,
run the following. The form and choice are inert. The confirmation call asks
only for a decision, so pressing a button here does not clear anything.

```js
const { renderPresentation } = await import("./runtime/ui.js");
const { page } = await import("./app.js");
renderPresentation(document.querySelector("#ns-msgs"), {
  version: 1,
  components: [
    {
      kind: "form",
      title: "Check options",
      schema: { properties: {
        network: { type: "string", title: "Network" },
        format: { type: "string", enum: ["Brief", "Detailed"], title: "Format" },
        view: { type: "string", enum: ["Evidence", "Changes"], title: "View", "x-ui": { widget: "radio" } },
        includePass: { type: "boolean", title: "Include passing checks" },
      } },
    },
    {
      kind: "choice",
      title: "Sample",
      options: [{ title: "Honest", value: "honest", subtitle: "A public probe", meta: "Sample network" }],
    },
  ],
}, null);
const { engine } = window.__nsweb;
const expectedVersion = page.readResult().lock.version;
void engine.onActionConfirm([{
  action: "clear_lock",
  description: "",
  effect: "irreversible",
  origin: location.origin,
  arguments: { expectedVersion },
}]).then(console.log);
```

Check the form, choice, dialog focus and labels at desktop and narrow widths.
Try **Keep the local lock** or Escape for `false`. Repeat the confirmation
call with `expectedVersion + 1` and check that it refuses without opening a
dialog. Try the consent card controls separately. This call sends no request.

```js
void engine.onConsent({
  kind: "network",
  peerLabel: "Honest",
  peerOrigin: "localhost:8082",
  requestText: "Answer a public probe.",
  est: { totalTokens: 200, costText: null },
}).then(console.log);
```

Select **Allow**, **Always allow** or **Decline** and check the value
logged. Reload the page to remove the test components. To verify the public
read via the runtime registry without a model provider, run this after
reloading.

```js
const { engine } = window.__nsweb;
const scope = { base: engine.top.base, network: engine.top.network.name };
const entry = engine.actions.catalog(scope).find(({ name }) => name === "check_peer");
if (entry?.effect === "read") {
  const plan = engine.actions.prepare({
    kind: "action", action: entry.ref, arguments: { url: "http://localhost:8082/honest" },
  });
  console.log(await engine.actions.execute(plan, Boolean, "console-check"));
}
```

## Build files and hosting

Build with
`node vendor/agentify-website/scripts/build_network.mjs app/preflight.hocon --manifest app/agent-manifest.json`.
Use `--check` for a read-only comparison. The primary manifest is a build
input and the bridge manifest is generated.

| Files | Purpose |
| --- | --- |
| `index.html`, `assistant.css`, `site.js` | Page mount, theme, lock review and visible peer stops |
| `app.js`, `preflight.js`, `site-actions.js`, `check-peer-action.js` | Shared page operations and action registration |
| `preflight.hocon`, `agent-manifest.json`, `links.json` | Network, policy, defaults and empty named-link map |
| `preflight.network.json`, `agent-mcp.json`, `.well-known/nsdeploy.json`, `.well-known/nsdeploy-agent.json` | Generated network and discovery |
| `bridge/action-bridge.html`, `bridge/agent-manifest.json`, `bridge/bridge-actions.js` | Generated bridge page and manifest, and the public read implementation |
| `runtime/`, `tests/` | Static browser runtime and offline integration tests |

The static app copies runtime files byte for byte. The optional LangChain
runner bundle stays in the lab copy. The static deployment disables that
runner.

Serve the repository layout over HTTPS. The app uses shared modules from
`core/` and `lab-caller/origins.js`. Send `Access-Control-Allow-Origin: *`
on the six public JSON endpoints listed below. Use JavaScript MIME types
for modules and leave the bridge frame embeddable. Do not set
`X-Frame-Options` or a `frame-ancestors` restriction on `app/bridge/`.

```text
app/agent-manifest.json
app/preflight.network.json
app/links.json
app/agent-mcp.json
app/.well-known/nsdeploy.json
app/.well-known/nsdeploy-agent.json
```

For `app/runtime/sandbox-worker.js`, set
`Content-Security-Policy: default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'`.
If the page has a CSP, its `connect-src` must allow the selected provider
and requested public artifact origins. Its `frame-src` must permit the
allowed sample origin when that origin publishes a bridge. A deployment
with `app/` under a subpath has discovery files at that subpath. A
domain-root registry lookup needs discovery published at the domain root.
The network URL can be submitted to the NANDA Index or the Worldwide
Agentic Web site's list when the deployment is ready.

## Verification boundary

The Node tests exercise the bundled static runtime with scripted inference
and fixture reads. They cover site actions, approval, same-router execution,
private-context omission, validation, cycles, budget and denied-origin stops.
Live HTTPS, direct provider inference, browser visuals and browser iframe
transport require a host and browser run.
