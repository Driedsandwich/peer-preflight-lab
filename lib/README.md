# Peer Preflight embed

Paste these two lines into your page. The pin URL resolves against your page's base URL.

```html
<script type="module" src="https://driedsandwich.github.io/peer-preflight-lab/lib/peer-preflight.js"></script>
<peer-preflight pin="./peers.lock.json"></peer-preflight>
```

Use a [version 1 peer lock](../core/README.md) like the one in the [demo](./demo.peers.lock.json). Each row shows the current verdict and whether the version matches the pin. Set `--peer-preflight-pass`, `--peer-preflight-caution` or `--peer-preflight-block` to customize the verdict colors.

## Browser API

All three functions on `window.peerPreflight` are async. They use the first `<peer-preflight>` with a `pin` attribute on the page. Each element also verifies its own lock when it connects or its pin changes.

| Function | Returns |
| --- | --- |
| `check(url)` | A fresh result for one absolute peer network URL. Includes a comparison when the peer has a readable pin. Also works without a lock. An invalid peer URL rejects. |
| `verifyLock()` | An array of fresh results for every pinned peer. Returns an empty array without a pin element. Rejects if the lock cannot be read or validated. |
| `shouldAllow(url)` | `true` only if the lock pins the peer, a fresh fingerprint exactly matches the pin, and the verdict is `Pass` or `Caution`. A `Block` decision in the lock also yields `false`. |

When the element updates its list, it emits a bubbling `peer-preflight:result` event for each peer with the result in `event.detail`, then one bubbling `peer-preflight:done` event with the results array in `event.detail`.

Results use the same JSON shape as the app's `window.peerPreflight.lastResult`.

| Field | Value |
| --- | --- |
| `peer` | `{ url, name, agentCount }`, with a nullable agent count. |
| `verdict` | `"Pass"`, `"Caution"` or `"Block"`. |
| `findings` | An array of `{ id, severity, title, detail, evidence }`, ordered by severity. |
| `changes` | The core diff with `changed` and before/after fingerprints, or `null` when a comparison is unavailable. Version 1 pins contain only the fingerprint for comparison. |
| `fingerprint` | The current SHA-256 hex digest, or `null` when the publication could not be fully read. |

Call `shouldAllow(url)` before granting consent and enforce the result in your own runtime. The embed does not intercept calls, execute peer code, or persist data.

Serve the embedding page over HTTPS or loopback HTTP for Web Crypto. A cross-origin module host, lock host or peer must permit the embedding page's origin through CORS (an explicit origin or `Access-Control-Allow-Origin: *`). The lock and peer files are read with credential-free GETs. Peer files must stay on the peer's origin, and lock and peer URLs must be served directly without redirects.
