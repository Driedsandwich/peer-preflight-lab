# Run the caller and peers on two origins

The lab needs two origins, one for the caller (`lab-caller/`) and one for the peer fixtures (`lab-peers/`). Run every command below from the root of this repository, with Node 22 on PATH. Nothing needs installing.

## Public addresses

| Role | Address | Host |
| --- | --- | --- |
| Caller | `https://driedsandwich.github.io/peer-preflight-lab/lab-caller/lab.html` | GitHub Pages. The site is served under the path `/peer-preflight-lab/lab-caller`. |
| Peers | `https://peer-preflight-peers.vercel.app` | Vercel. The folder `lab-peers/` is the site root. `lab-peers/vercel.json` adds `Access-Control-Allow-Origin: *` to every path. |

The files in this repository carry these addresses. The logical network URL is the peer origin followed by the export name, for example `https://peer-preflight-peers.vercel.app/honest`. A live run on the two public hosts is **unverified**. The notes are in the README under "Public hosting".

Use the same steps below. Open the caller's `lab.html` instead of `http://127.0.0.1:8081/lab.html`, and read the peer origin as the Vercel address wherever the steps say `http://localhost:8082`.

## Run it on your own machine

The local set uses two ports. The caller is `http://127.0.0.1:8081` and the peers are `http://localhost:8082`. The two names for the same machine keep their cookies apart.

1. Write the local addresses into the fixtures and rebuild them. It exits 0 when the results are as expected (`broken` must fail its build).

   ```sh
   node scripts/set_origins.mjs --local
   ```

2. Start the two servers, one in each terminal.

   **Terminal 1 — caller**

   ```sh
   node vendor/agentify-website/scripts/serve_site.mjs lab-caller --host 127.0.0.1 --port 8081
   ```

   **Terminal 2 — peer collection**

   ```sh
   node vendor/agentify-website/scripts/serve_site.mjs lab-peers --host 127.0.0.1 --port 8082 --open-as localhost
   ```

3. When you are done, stop both processes with Ctrl-C and put the public addresses back before you commit:

   ```sh
   node scripts/set_origins.mjs --public
   ```

`node scripts/set_origins.mjs --check` changes nothing and only re-runs the build check. `--no-build` rewrites the text and skips the rebuild.

## Steps

1. Open **http://127.0.0.1:8081/lab.html**. Keep this hostname for the caller and use **http://localhost:8082** for the peers. The runtime can mirror BYOK profiles in a host cookie on loopback. Different hostnames separate those cookies. The peer collection root manifest lists the files of all the fixtures, giving the server the exact paths to serve with CORS.
2. Select **Inspect publication**, **Run default model**, then **Call inspector**. The last result should contain a succeeded receipt with `check` set to `local`. The default-model check automatically declines optional remote tools while the browser mock works through its local tools.
3. Select **Request honest peer**. While the card is open the ledger should contain zero peer requests. Decline once, then repeat and allow once. Look for the peer manifest, `/honest/honest.network.json` and the local `honest/honest` agent invocation.
4. Select **Trace test credential**. The peer will declare `/unused-router/v1`. Only in-memory requests to the caller’s `/lab-script/v1/chat/completions` should show a credential. The ledger displays flags. The optional `--log /path/to/peer-requests.jsonl` argument on the peer server records what actually reached that server, including authorization presence and cookie names. A hosted peer has no such log.
5. Select **Compare field grants** and approve the two runs. Inspect the receiving peer’s field names. Then choose each case under **Failure boundaries** and press **Run failure case**. For the budget and policy checks, allow the initial card so execution reaches the corresponding guard. Each run starts with a fresh engine, cache, consent state and turn budget.
6. Open **Assistant & BYOK settings** for the organizer’s own assistant and settings panel. It reads the published default, and offers the provider URL, model, credential, save and profile deletion controls. A live BYOK demonstration requires a separately available provider that supports browser CORS. The repeatable diagnostic buttons use the marked canary and scripted route automatically. A real credential is unnecessary for these checks.

The engine first gets the manifest from the containing directory and resolves its `hocon` entry. To inspect the sole-export exact-name case locally, serve `lab-peers/near_name` on port 8082 instead of the collection and run **Near name**. The loop, depth and multi-peer budget cases need the collection.

## Redirects and hosting

The local server serves files and issues a same-origin slash redirect for directories. The redirect button reads the peer manifest’s `lab_http_fixture` after consent and replays a cross-origin 302 in memory. For a host with HTTP redirect rules, the collection’s `_redirects` gives the source path, target URL and 302 status. Apply the equivalent server-side rule on that host. Vercel is expected not to read `_redirects` (not checked here), and `lab-peers/vercel.json` adds no redirect, so on Vercel only the in-memory replay is expected to apply. A real redirected browser fetch is **unverified**.

To use other hosts, first run `node scripts/set_origins.mjs --local` so the files carry a known set. Then edit the `public` set in `lab-caller/origins.js` and run `node scripts/set_origins.mjs --public`. The script replaces the values of the set it is not switching to, so it cannot find an old public value that was edited away. It updates the absolute peer URLs and `link_labels` in the HOCON, `allowed_peers` and `peer_policy.deny_origins` in the manifests and the redirect rule, rebuilds the generated files, and checks them. The tests and the lab page read the same file. Keep the collection manifest paths and exports in sync with the fixture manifests. Serve `Access-Control-Allow-Origin: *` on the peer root manifest, links and every definition path listed in its manifest. The caller’s read action runs on the caller origin. Its generated bridge shares no actions.
