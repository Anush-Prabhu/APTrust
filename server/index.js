/**
 * APTrust local index server (POC).
 *
 * Responsibilities:
 *   - GET /health                -> simple liveness check
 *   - GET /search?q=             -> alias/name search across entries.json
 *   - GET /entry/:domain         -> full entry + TXT-style simulated payload
 *   - GET /manifest/:domain      -> serves the local manifest file
 *                                   (TODO: redirect to GitHub raw URL later)
 *
 * Data sources:
 *   ../aptrust-records/index/entries.json
 *   ../aptrust-records/domains/<domain>/manifest.jsonld
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 8787;

const ROOT = path.resolve(__dirname, '..');
const RECORDS_DIR = path.join(ROOT, 'aptrust-records');
const INDEX_FILE = path.join(RECORDS_DIR, 'index', 'entries.json');
const DOMAINS_DIR = path.join(RECORDS_DIR, 'domains');

const TXT_CHUNK_LIMIT = 225;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadEntries() {
  const raw = fs.readFileSync(INDEX_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.entries || [];
}

function normalize(q) {
  return String(q || '').trim().toLowerCase();
}

function matchEntry(entry, q) {
  if (!q) return false;
  const hay = [
    entry.canonicalDomain,
    entry.displayName,
    ...(entry.aliases || [])
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  return hay.some((s) => s.includes(q));
}

function chunkString(str, size) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks;
}

/**
 * Build a compact JSON payload that simulates what a DNS TXT record would
 * carry if we were doing a real lookup. Intentionally tiny so it fits into
 * a few 225-char chunks.
 */
function buildTxtSimulation(entry) {
  const compact = {
    d: entry.canonicalDomain,
    m: entry.manifestUrl,
    h: entry.manifestHash,
    v: entry.version
  };
  const raw = JSON.stringify(compact);
  return {
    raw,
    chunkLimit: TXT_CHUNK_LIMIT,
    chunks: chunkString(raw, TXT_CHUNK_LIMIT)
  };
}

function findEntryByDomain(entries, domain) {
  const needle = normalize(domain);
  return entries.find((e) => normalize(e.canonicalDomain) === needle);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'aptrust-index-server', port: PORT });
});

app.get('/search', (req, res) => {
  const q = normalize(req.query.q);
  if (!q) {
    return res.json({ query: '', results: [] });
  }

  let entries;
  try {
    entries = loadEntries();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load index', detail: err.message });
  }

  const results = entries
    .filter((e) => matchEntry(e, q))
    .map((e) => ({
      canonicalDomain: e.canonicalDomain,
      displayName: e.displayName,
      aliases: e.aliases || [],
      version: e.version
    }));

  res.json({ query: q, results });
});

app.get('/entry/:domain', (req, res) => {
  let entries;
  try {
    entries = loadEntries();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load index', detail: err.message });
  }

  const entry = findEntryByDomain(entries, req.params.domain);
  if (!entry) {
    return res.status(404).json({ error: 'Entry not found', domain: req.params.domain });
  }

  const payload = {
    canonicalDomain: entry.canonicalDomain,
    displayName: entry.displayName,
    aliases: entry.aliases || [],
    manifestUrl: entry.manifestUrl,
    manifestHash: entry.manifestHash,
    version: entry.version,
    hashVerificationEnabled: entry.hashVerificationEnabled === true,
    txtSimulation: buildTxtSimulation(entry)
  };

  res.json(payload);
});

/**
 * Serve the local manifest file for a canonical domain.
 *
 * TODO (GitHub redirect):
 *   Later, flip this endpoint into a 302 redirect to a canonical GitHub raw URL.
 *   Example:
 *     const raw = `https://raw.githubusercontent.com/<org>/aptrust-records/main/domains/${domain}/manifest.jsonld`;
 *     return res.redirect(302, raw);
 *   The extension already treats manifestUrl as opaque, so no extension changes
 *   are needed when this flip happens.
 */
app.get('/manifest/:domain', (req, res) => {
  const domain = normalize(req.params.domain);
  if (!/^[a-z0-9.-]+$/.test(domain)) {
    return res.status(400).json({ error: 'Invalid domain' });
  }

  const manifestPath = path.join(DOMAINS_DIR, domain, 'manifest.jsonld');
  if (!manifestPath.startsWith(DOMAINS_DIR)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  fs.readFile(manifestPath, 'utf8', (err, data) => {
    if (err) {
      return res.status(404).json({ error: 'Manifest not found', domain });
    }
    try {
      const parsed = JSON.parse(data);
      res.setHeader('Content-Type', 'application/ld+json; charset=utf-8');
      res.send(JSON.stringify(parsed));
    } catch (parseErr) {
      res.status(500).json({ error: 'Manifest is not valid JSON', detail: parseErr.message });
    }
  });
});

/**
 * POST /report — mockup impersonation-report sink.
 *
 * TODO (real delivery):
 *   In a production system the extension would read `reportContact` from the
 *   manifest (email, secure endpoint, etc.) and deliver there. For this POC
 *   we just log to the console so the flow is observable end-to-end.
 */
app.post('/report', (req, res) => {
  const body = req.body || {};
  const id = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    receivedAt: new Date().toISOString(),
    url: body.url || null,
    reason: body.reason || null,
    boundary: body.boundary || null,
    userAgent: req.get('user-agent') || null,
    submittedAt: body.submittedAt || null
  };
  console.log('[aptrust] /report (mockup) received:', JSON.stringify(record, null, 2));
  res.status(201).json({
    ok: true,
    id,
    message:
      `Mockup report filed for boundary ${record.boundary && record.boundary.canonicalDomain}. ` +
      `A real delivery would route this to the manifest's reportContact.`
  });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`[aptrust] index server listening on http://localhost:${PORT}`);
  console.log(`[aptrust] records dir: ${RECORDS_DIR}`);
});
