# Peer Preflight

Peer Preflight is a dependency-free ES module for browsers with Web Crypto and for Node 22. It fetches public peer artifacts without credentials, checks them deterministically, and compares them with a pinned version. It uses no LLM and executes no peer agents or tool code.

## API

Import from `./src/preflight-core.mjs`.

| Function | Result |
| --- | --- |
| `resolvePeer(url)` | `{ base, name }` from an HTTPS peer URL. Loopback HTTP is supported for development. |
| `await fetchPeer(url, { fetch })` | `{ manifest, network, links, response, sha256 }`. Requires an exact manifest match, loads the declared JSON or resolved HOCON and the selected network's bindings from `links.json`, then fingerprints `{ manifest, network, links }`. Each response records the requested URL, final URL, status and visible CORS header when available. Browser responses of type `cors` also record `corsVerified: true`. |
| `await fingerprint(obj)` | Lowercase SHA-256 hex over UTF-8 JSON with recursively sorted object keys and preserved array order. |
| `inspect(snapshot, { allowedFields, callerOrigin, callerRouter })` | Findings with `id`, `severity`, `title`, `detail` and `evidence`. Supply exact allowed field names. The caller's router URL is optional. |
| `await diff(pinnedSnapshot, currentSnapshot)` | `changed`, before and after fingerprints, per-agent instruction additions and removals with line numbers, tool and destination additions and removals, and `hasSnapshots`. Retain the pinned snapshot for detailed comparisons. A lock entry alone supports fingerprint comparison. |
| `verdict(findings, comparison)` | The first matching verdict below. The comparison is optional. |
| `readLock(text)` / `writeLock(lock)` | Parse or serialize the version 1 lock. The caller handles storage. |

The lock document has `version: 1` and a `peers` object keyed by peer network URL. Each entry has `sha256`, `pinned_at` (an ISO timestamp) and `verdict` (`Pass`, `Caution` or `Block`).

A missing link map (HTTP 404 or 410) supplies no bindings. An unreadable link map yields Caution. Manifest and network retrieval failures reject the fetch. A retrieved network with invalid syntax yields Block. Very large instruction edits may report the entire changed middle of the text after trimming shared leading and trailing lines.

## Verdicts

| Verdict | Rule |
| --- | --- |
| Block | At least one `block` finding, such as an invalid network or an instruction takeover pattern. |
| Caution | At least one `caution` finding or any pinned change, including an instruction edit. |
| Caution (field request) | An instruction asks, after a request verb, for a field outside `allowedFields` and not negated. Besides fixed names (home address, email, phone, name, password, API key) and fields in the network's allow lists, it covers snake_case names in the forms `<name> field`, `field <name>` and `the <name> value`, and fields marked private, unshared, secret, hidden or personal. |
| Pass (contact asks) | An instruction that only asks or confirms the visitor's own email, phone, address or name in conversation yields an `asks-visitor-contact` finding with severity `info`. Including such a value in requests, bookings or partner calls, or asking for fields marked private or taken from `sly_data`, stays a Caution. Passwords and API keys are unchanged. |
| Pass (local destinations) | A new outbound destination at `localhost`, `127.0.0.1` or `[::1]` yields an `info` finding. |
| Pass | The remaining cases. `info` findings, such as inter-agent cycles or peer router declarations, allow Pass. |

## Specification and runtime

Based on `docs/worldwide_agentic_web_mvp_spec.md` (MVP Profile 0.3). Sections 2.1–2.2 cover network and private-context structure. §§3.1–3.4 cover validation, cycles, resolution, public artifacts and CORS. §4 gives the caller's router precedence. §5 motivates instruction checks, explicit destinations and coded-tool findings. The MVP does not standardize the pin format (§7).

Vendored Apache-2.0 excerpts from `skills/agentify-website/runtime/` at revision `d67755e` are listed below. The upstream license is in `vendor/LICENSE.txt`.

| Vendored file | Source and lines |
| --- | --- |
| `vendor/hocon.mjs` | `hocon.js:13–262`. Object construction preserves own keys safely and malformed values must advance the parser. |
| `vendor/kernel.mjs` | `kernel.js:94–168, 172–183, 189–201, 218–237` and `model.js:5–15`. Imports point to the local excerpts. Configuration copying preserves own keys safely. The class keeps the members used by validation and graph inspection. |
| `vendor/graph.gen.mjs` | `generated/graph.gen.mjs:1–83`. |
| `vendor/validation.gen.mjs` | `generated/validation.gen.mjs:1–70`. |

Artifact lookup follows `remote.js:6–25` and `engine.js:209–224, 261–269, 422–445`. Relative artifact paths, including paths with a leading slash, resolve from the original site base. Fetch follows redirects and inspection compares the requested and final origins. Interactive consent and redirect approval belong to the calling application (§5).

## Tests and Unverified

Run `node --test "core/tests/*.test.mjs"` from the repository root. **30 tests** use local fixtures and injected fetch.

**Unverified.** Real browser behavior, live CORS and redirects, and peer behavior at execution time. A browser may reject CORS before exposing a response, or withhold the header from JavaScript. Fetch exposes the final URL, so intermediate redirect destinations are unverified. Instruction findings use English phrase matching. Coverage of other languages, alternate wording and obfuscation is unverified. An SRI finding reports the declared digest's form. Bundle content and digest validity at execution time are unverified.
