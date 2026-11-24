# Foundation Lab

A static, two-origin test bench for participants building their first agentic website. Use the same caller, peer fixtures and observations across different entries. The inspector reads real page state. The inference used for repeatable checks is local and deterministic.

**Start with the seven buttons at `/lab.html`.** The [two-origin guide](serve_two_origins.md) gives the two server commands, the consent sequence and the expected ledger. The ordinary assistant and BYOK settings are at `/index.html`. [File inventory](FILELIST.txt)

## Reproduce the offline checks

From the directory containing `files/`, with Node 22 on PATH, run

```sh
node --test "files/tests/*.test.mjs"
```

**Node v22.23.4 — 22 cases passed, 0 failed, 0 skipped.** The quoted command exited 0. In the supplied environment its isolated reporter listed one passing test file. Running the same suite with `node --experimental-test-isolation=none --test "files/tests/*.test.mjs"` exposed the 22 individual case results. Tests use disk-backed artifact responses, the runtime’s engine and manual agent loop, the actual action module, the skill’s scripted model, and a DOM stand-in for the button handlers. No package installation is needed.

To check the publications against the imported skill, set `SKILL_DIR` to its path and run

```sh
SKILL_DIR="${SKILL_DIR:-$PWD/skills/agentify-website}"
for src in files/lab-caller/*.hocon files/lab-peers/*/*.hocon; do
  node "$SKILL_DIR/scripts/build_network.mjs" "$src" \
    --manifest "${src%/*}/agent-manifest.json" \
    --runtime files/lab-caller/runtime --check
  echo "$src exit $?"
done
```

| Site or fixture | Build check | Runtime observation |
| --- | --- | --- |
| `lab-caller` | Pass | Two compiled agents, `foundation` and `inspector`. The specialist reads the selected check using `website_read_check`. |
| `honest` | Pass | Approval precedes the first peer GET. Declining produces zero peer GETs. |
| `broken` | Expected rejection, exit 1 | Structural validation reports the missing tool `missing_member`. No peer agent starts. |
| `loop_a`, `loop_b` | Both pass | A and B each run once. The return edge to active A is removed from the offered tool table and a skip is recorded. |
| `greedy` | Pass | Four remote calls consume the shared budget. In a separate turn, 24 agent invocations consume the agent budget. Subsequent invocations are skipped. |
| `key_thief` | Pass | The caller keeps its selected router/model through peer execution. Only its scripted inference requests carry the canary. |
| `sly_snoop` | Pass | The direct hop receives exactly `lab_color`. The same peer behind a no-grant intermediary receives an empty object. |
| `near_name` | Pass | Requesting `near_name` rejects even when `near_name_v2` is the sole export. No definition is fetched. |
| `redirector` | Pass | A replayed cross-origin 302 stops the definition load. The destination is never contacted during the replay. |

The builder accepted nine of ten inputs. For `broken`, the manifest deliberately serves raw HOCON. The builder also reports the nonstandard output filename and missing generated artifacts because no valid publication can be built from that source. The other publications were written by `build_network.mjs`. To rebuild a valid fixture, repeat its command without `--check`. The remaining warnings concern the optional CRUSE widgets, which these checks do not use, and the caller’s open peer policy, which activates the runtime’s `deny_origins` branch. Runtime bytes in `lab-caller/runtime/` match the imported skill recursively.

## What each button establishes

1. **Static publication.** The caller loads its manifest, HOCON source and compiled definition. The server request handler, exercised without a socket, returned 200 for both sites’ manifests and links, the caller definition and all nine declared peer definitions. The public artifact responses included the wildcard CORS header. The lab and settings HTML and local script assets were also readable.
2. **Default and BYOK inference.** The untouched `browser://mock` client runs the top network with its published model `gpt-4.1-nano`. The local check declines optional peer calls automatically. Scripted checks select a separate caller-owned route and model `gpt-4.1-mini` through the engine’s BYOK inputs. `index.html` mounts the runtime’s own settings panel. For a publisher-funded service, edit the caller manifest’s `llm_router`: set `base_url` to the publisher endpoint, `mock` to false and `publisher_funded` to true. Keep a distinct `byok_router` for visitor credentials. Funding and real inference need a separately operated service.
3. **Internal agent and action.** The scripted model asks `foundation` to delegate to `inspector`. Its local-only read action wraps `page.readCheck()`. The runtime returns a succeeded receipt with the actual selection. The bridge exports no reads or writes.
4. **Consent and exact names.** The test holds the consent promise open and inspects requests while the caller is waiting. After approval, the caller fetches the matching peer’s static definition and invokes its front agent in the same engine. The reverse decision and the near-name case each have a separate test.
5. **Credential ledger.** Each fetch observation contains destination, purpose and credential-presence flags. The probe examines URL, headers and body for a marked test credential before handing off a request. The real runtime constructs the model POST. The lab answers that one route in memory with scripted SSE. Peer origins receive public GETs only. No canary value appears in the visible ledger, runtime trace or chat history. The diagnostic fetch adapter explicitly sets credential mode `omit` and redirect mode `error` on file loads. The ledger covers the diagnostic engine’s fetches. A page navigation, native module import or browser-managed cookie would require observation at the server or browser.
6. **Private context.** Tests inspect both the redacted peer-call event and the actual context built for the peer. Only the two privacy probes supply synthetic private fields. The runtime reads the sending network’s front-agent rule, so the named grant has front-agent scope. For the return direction, the kernel helper selects only `receipt_label`, and a normal completed peer call returns its answer with no `sly_data` envelope. End-to-end forwarding of a named upstream field is **未確認**.
7. **Visible stops.** The page shows validation and policy errors, cycle skips and the runtime’s exact budget reasons. With an allowed card, a denied origin still receives zero requests. The depth run sets `maxDepth` to 2 to isolate the depth guard before the default remote-call budget wins. A separate test exercises the default depth of 5 and distinct registry exception codes. At the dispatched-tool boundary the runtime gives depth and cycle the same skip wording. A failed child invocation can return a tool error or skip while the outer turn finishes.

## Reuse and evidence

`lab-caller/` contains the two-agent source, discovery files, read-only action, organizer runtime, assistant and diagnostic page. `lab-peers/` has one collection manifest for simultaneous loopback service and a standalone manifest in each fixture directory. The collection adopts the alternate router declaration from `key_thief` so that fixture also works on a single peer port. For another participant’s first check, serve their own caller with the honest peer’s exact URL in its tools, label and peer policy. Use the decline/approve pair and inspect the peer log. When adapting the lab itself, change HOCON and manifest inputs, rebuild, and update the tests that assert your graph’s names, action receipt and permission fields.

All source references below are paths in the imported checkout, commit `f3fab94`. The checked-in specification is Profile 0.3. Its seven §6 checks match the local Profile 0.2 revision `fd872b9` verbatim.

| Evidence | Repository file and lines |
| --- | --- |
| Profile, exact export, definition fetch, private returns, destination consent and seven checks | `docs/worldwide_agentic_web_mvp_spec.md:5,239–255,394–410,427–445` |
| Build inputs, generated files and test procedure | `skills/agentify-website/SKILL.md:73–85,103–127,152–170` and `skills/agentify-website/scripts/build_network.mjs:176–220` |
| Organizer runtime and publisher-funded settings | `skills/agentify-website/runtime/README.md:3–8,87–100` |
| Model selection, validation, caller router inheritance | `skills/agentify-website/runtime/engine.js:59–109,165–195,209–248,388–400` |
| Consent, exact resolution, cycle/depth and session invocation | `skills/agentify-website/runtime/runner.js:190–205,436–482`, `runtime/engine.js:421–460,602–634`, `runtime/remote.js:6–18,27–59` |
| Browser mock and outbound model headers | `skills/agentify-website/runtime/llm.js:15–44,70–136` |
| Limits, local delegation, reads, receipts | `skills/agentify-website/runtime/engine.js:547–558`, `runtime/runner.js:63–84,366–385,494–504`, `runtime/actions.js:133–155` |
| Private fields and the return path | `skills/agentify-website/runtime/kernel.js:36–59`, `runtime/runner.js:473–481`, `runtime/engine.js:602–630` |
| Settings and template test pattern | `skills/agentify-website/runtime/index.js:37–77`, `runtime/ui.js:330–386`, `templates/tests/agentified.test.mjs:1–15,81–118`, `templates/tests/scripted_model.mjs:1–49` |
| Public file paths and server logs | `skills/agentify-website/scripts/serve_site.mjs:257–270,339–384,415–438` |

Short paths beginning with `runtime/` and `templates/` in this table are relative to `skills/agentify-website/`.

## Unverified (未確認)

- **Live browser and hosting.** This environment refused both loopback listeners with `listen EPERM`. Browser rendering, keyboard and consent interaction in a real tab, actual HTTP/TLS delivery, browser CORS enforcement, browser-generated cookies and wire-level traffic remain 未確認. The DOM stand-in exercised all seven HTML handlers and every failure selector. No screenshots were taken.
- **Inference services.** Live BYOK, provider acceptance of a model, settings/profile persistence in a real browser, publisher-funded billing and live provider behavior under peer instructions remain 未確認. A scripted peer exercises routing and data access deterministically.
- **Redirects.** The organizer’s loader uses plain `fetch` for public files. The diagnostic adapter requests rejection of redirects. The 302 replay and the fixture’s hosting rule capture the intended stop. Automatic re-consent at a new origin by the unmodified runtime and a real host’s redirect behavior remain 未確認. The specification discusses normal redirects at lines 248–251 and destination consent at lines 394–397.
- **Upstream transport and destination-specific grants.** The normal peer reply path returned no private envelope in this suite. Applying `allow.to_upstream` to a peer’s private return payload, and enforcing independent per-destination grants from one front agent, remain 未確認.
