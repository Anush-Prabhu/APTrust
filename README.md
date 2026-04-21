# APTrust — Trust-Boundary Verification POC

A runnable proof-of-concept for a trust-boundary verification system, built with:

- A Chrome **Manifest V3** browser extension
- A local **Node.js + Express** index server
- Per-domain **JSON-LD** manifests under `aptrust-records/`

The extension lets a user enable **Protect Mode**, pick a trust boundary
(e.g. `jhu.edu`), load that boundary's manifest, and **warn** (never block) when
visited URLs, pasted URLs, page links, or redirects fall outside the boundary.

---

## Project layout

```
aptrustdemo/
├── README.md
├── aptrust-records/
│   ├── domains/
│   │   └── jhu.edu/
│   │       └── manifest.jsonld          # Sample JHU JSON-LD manifest
│   └── index/
│       └── entries.json                 # Local canonical-domain index
├── server/
│   ├── package.json
│   └── index.js                         # Express index server
└── extension/
    ├── manifest.json                    # MV3 extension manifest
    ├── popup.html / popup.css / popup.js
    ├── background.js                    # Service worker (MV3 module)
    ├── content.js                       # Link scan + paste detection + banner
    └── src/
        ├── config.js                    # Shared config + constants
        ├── normalize.js                 # URL/host normalization helpers
        └── evaluator.js                 # buildBoundary + evaluateUrl + sha256
```

---

## 1. Run the local index server

Requires Node.js 18+.

```bash
cd server
npm install
npm start
```

You should see:

```
[aptrust] index server listening on http://localhost:8787
```

Smoke-test:

```bash
curl http://localhost:8787/health
curl "http://localhost:8787/search?q=jhu"
curl http://localhost:8787/entry/jhu.edu
curl http://localhost:8787/manifest/jhu.edu
```

### Endpoints

| Method | Path                  | Purpose                                               |
| ------ | --------------------- | ----------------------------------------------------- |
| GET    | `/health`             | Liveness                                              |
| GET    | `/search?q=<text>`    | Alias/name search across `entries.json`               |
| GET    | `/entry/:domain`      | Full entry + `txtSimulation` (225-char chunked)       |
| GET    | `/manifest/:domain`   | Serves the manifest file for `:domain`                |

**`/manifest/:domain` is the redirect/proxy point.** It currently reads the
local file from `aptrust-records/domains/<domain>/manifest.jsonld`. There is a
clearly marked `TODO` in `server/index.js` showing how to flip it to a 302
redirect to a GitHub raw URL later without touching the extension.

### TXT-style simulation

`/entry/:domain` returns a `txtSimulation` object that mimics how a DNS TXT
record would look if it only carried the bare minimum:

```json
{
  "raw": "{\"d\":\"jhu.edu\",\"m\":\"http://localhost:8787/manifest/jhu.edu\",\"h\":\"sha256-pending\",\"v\":\"0.1.0\"}",
  "chunkLimit": 225,
  "chunks": ["{\"d\":\"jhu.edu\", ... }"]
}
```

The extension uses the parsed JSON response for actual logic — the simulation
is available for inspection but not on the hot path.

---

## 2. Load the extension in Chrome

1. Open **`chrome://extensions`**
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** and pick the `extension/` folder
4. The **APTrust** action will appear in your toolbar. Pin it.

> The manifest intentionally ships without icon PNGs to keep this POC free of
> binary assets. Chrome uses a default puzzle-piece icon. Add PNGs to
> `extension/icons/` and wire them back into `manifest.json` if desired.

---

## 3. Use it

1. Click the APTrust icon to open the popup.
2. Flip **Protect Mode** on.
3. Type `jhu` in the search box.
4. Click the **Johns Hopkins University** result.
5. The popup shows the selected boundary and the current tab's verdict.
6. Browse around. Untrusted pages show a red banner at the top. Untrusted
   links get a red dashed outline. Pasted untrusted URLs show a warning.
   The toolbar badge shows `OK`, `!`, or `X` per tab.

### What should be trusted (given `jhu.edu` is selected)

- `https://www.jhu.edu/`, `https://sais.jhu.edu/…` → **trusted**
- `https://www.johnshopkins.edu/`, `https://www.jhsph.edu/` → **trusted**
- `https://x.com/JohnsHopkins` → **trusted** (exact social profile)
- `https://johnshopkins.employment.ngwebsolutions.com/` → **trusted**
- `https://jhuu.edu/` → **untrusted**
- `https://x.com/JohnsHopkinsHelp` → **untrusted** (not declared)
- `https://deprecated.jhu.edu/` → **excluded**

---

## 4. Acceptance notes

You should be able to:

1. Run the local index server (`npm start` in `server/`).
2. Load the unpacked extension in Chrome.
3. Enable Protect Mode.
4. Search for `jhu`.
5. Select `jhu.edu`.
6. See the manifest load successfully (popup shows the selected boundary and
   the background logs a SHA-256 digest line).
7. Navigate to trusted and untrusted URLs.
8. See red warnings (banner + badge + outlined links) for URLs outside the
   selected trust boundary. Navigation itself is never blocked.

---

## 5. What's deliberately not done yet

These are all scaffolded but not active, with `TODO` comments in the code:

- **Hash verification.** `sha256Hex()` runs on every manifest fetch and logs
  the digest. To enforce it, set `CONFIG.enforceHashVerification = true` in
  `extension/src/config.js`, set `hashVerificationEnabled: true` in
  `aptrust-records/index/entries.json`, and replace `sha256-pending` with a
  real `sha256-<hex>` value. `background.js -> loadManifest()` already
  compares and will throw on mismatch under those conditions.
- **GitHub raw manifest redirect.** `GET /manifest/:domain` is where to flip
  from "read local file" to "302 to
  `https://raw.githubusercontent.com/<org>/aptrust-records/main/domains/<d>/manifest.jsonld`".
  `entries.json` still just stores an opaque `manifestUrl`, so you can either
  change the endpoint or change the URL in the entry — both are valid.
- **Nameserver-based trust.** The manifest carries nameserver info under
  `aptrust:verificationMethod.nameserverMetadata` **as metadata only**. It is
  explicitly not used by the evaluator.
- **Blocking.** The extension observes and warns. It never cancels navigation
  or calls `preventDefault` on link clicks.

---

## 6. Trust rules (reference)

Evaluation order in `extension/src/evaluator.js -> evaluateUrl()`:

1. **Exclusions** (exact or subdomain) always win → `excluded`.
2. **Social-platform hosts** (`x.com`, `facebook.com`, etc. — see
   `CONFIG.socialHosts`) are trusted **only** via exact URL match against
   `sameAsSocialProfile`.
3. **Additional profiles** are trusted **only** via exact URL match against
   `sameAsAdditionalProfile`.
4. **Trusted domains** (primary + `sameAsDomain` + `trustBoundary.*` +
   identifiers) are trusted by **exact host or subdomain**.
5. Everything else → `untrusted`.

URL normalization strips a leading `www.`, lowercases host + scheme, drops a
trailing slash, and (for social/additional comparisons) drops the query
string. Social handles remain **case-sensitive** by design — `x.com/Foo` and
`x.com/foo` are different profiles.

---

## 7. Extending

- **Add another boundary:** drop
  `aptrust-records/domains/<new.tld>/manifest.jsonld`, add an entry to
  `aptrust-records/index/entries.json`, restart the server. No extension
  changes needed.
- **Change evaluation logic:** it all lives in
  `extension/src/evaluator.js`. `background.js` is a thin wrapper.
- **Swap the server:** the extension only speaks three URLs: `/search`,
  `/entry/:domain`, and whatever `manifestUrl` the entry carries. Anything
  that answers those can replace this server.
