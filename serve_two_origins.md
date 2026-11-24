# Run the caller and peers on two origins

Use Node 22 and the imported `cognizant-ai-labs/agentic-web` checkout. Start both commands from the directory containing `files/`. If the checkout is elsewhere, set `SKILL_DIR` in **each** terminal to the absolute path of its `skills/agentify-website` directory.

**Terminal 1 — caller**

```sh
SKILL_DIR="${SKILL_DIR:-$PWD/skills/agentify-website}"
node "$SKILL_DIR/scripts/serve_site.mjs" files/lab-caller --host 127.0.0.1 --port 8081
```

**Terminal 2 — peer collection**

```sh
SKILL_DIR="${SKILL_DIR:-$PWD/skills/agentify-website}"
node "$SKILL_DIR/scripts/serve_site.mjs" files/lab-peers --host 127.0.0.1 --port 8082 --open-as localhost
```

1. Open **http://127.0.0.1:8081/lab.html**. Keep this hostname for the caller and use **http://localhost:8082** for the peers. The runtime can mirror BYOK profiles in a host cookie on loopback. Different hostnames separate those cookies. The peer collection root manifest lists the files of all nine fixtures, giving the server the exact paths to serve with CORS.
2. Select **Inspect publication**, **Run default model**, then **Call inspector**. The last result should contain a succeeded receipt with `check` set to `local`. The default-model check automatically declines optional remote tools while the browser mock works through its local tools.
3. Select **Request honest peer**. While the card is open the ledger should contain zero peer requests. Decline once, then repeat and allow once. Look for the peer manifest, `/honest/honest.network.json` and the local `honest/honest` agent invocation.
4. Select **Trace test credential**. The peer will declare `/unused-router/v1`. Only in-memory requests to the caller’s `/lab-script/v1/chat/completions` should show a credential. The ledger displays flags. The optional `--log /path/to/peer-requests.jsonl` argument on the peer server records what actually reached that server, including authorization presence and cookie names.
5. Select **Compare field grants** and approve the two runs. Inspect the receiving peer’s field names. Then choose each case under **Failure boundaries** and press **Run failure case**. For the budget and policy checks, allow the initial card so execution reaches the corresponding guard. Each run starts with a fresh engine, cache, consent state and turn budget.
6. Open **Assistant & BYOK settings** for the organizer’s own assistant and settings panel. It reads the published default, and offers the provider URL, model, credential, save and profile deletion controls. A live BYOK demonstration requires a separately available provider that supports browser CORS. The repeatable diagnostic buttons use the marked canary and scripted route automatically. A real credential is unnecessary for these checks.
7. Stop both processes with Ctrl-C.

The logical network URL is the origin followed by the export name, for example `http://localhost:8082/honest`. The engine first gets the manifest from the containing directory and resolves its `hocon` entry. To inspect the sole-export exact-name case, serve `files/lab-peers/near_name` on port 8082 instead of the collection and run **Near name**. The loop, depth and multi-peer budget cases need the collection.

## Redirects and hosting

The local server serves files and issues a same-origin slash redirect for directories. The redirect button reads the peer manifest’s `lab_http_fixture` after consent and replays a cross-origin 302 in memory. For a host with HTTP redirect rules, the collection’s `_redirects` gives the source path, target URL and 302 status. Apply the equivalent server-side rule on that host. Its support for that rule and an actual redirected browser fetch are **未確認**.

For public hosting, use HTTPS on both hosts. Update the absolute peer URLs and `link_labels` in the caller and loop/greedy HOCON, `allowed_peers` and `peer_policy.deny_origins` in the manifests, and the lab addresses in `probe.js`, the standalone/collection redirect fixtures, tests and action loader. Keep the collection manifest paths and exports in sync with the fixture manifests. Rebuild from HOCON and run the tests. Serve `Access-Control-Allow-Origin: *` on the peer root manifest, links and every definition path listed in its manifest. Keep the runtime worker CSP from `serve_site.mjs`. The caller’s read action runs on the caller origin. Its generated bridge shares no actions.

Serving and CORS implementation evidence is in `skills/agentify-website/scripts/serve_site.mjs:257–270,339–384,415–438`. Hostname guidance is in `skills/agentify-website/SKILL.md:164–170`.
