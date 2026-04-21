/**
 * APTrust background service worker (MV3).
 *
 * Responsibilities:
 *   - Own the current state: protectMode + selected entry + manifest + boundary.
 *   - Talk to the local index server (search, entry fetch, manifest fetch).
 *   - Evaluate tab URLs + redirect targets and set an action badge.
 *   - Respond to messages from popup.js and content.js.
 */

import { CONFIG, STATUS } from './src/config.js';
import { buildBoundary, evaluateUrl, sha256Hex } from './src/evaluator.js';
import { extractHost, isEmailHost } from './src/normalize.js';

// ---------------------------------------------------------------------------
// In-memory cache of the current boundary. Hydrated from storage on startup.
// ---------------------------------------------------------------------------

let STATE = {
  protectMode: false,
  selectedEntry: null, // { canonicalDomain, displayName, manifestUrl, manifestHash, hashVerificationEnabled, version }
  manifest: null,
  boundary: null
};

async function hydrateFromStorage() {
  const keys = CONFIG.storageKeys;
  const stored = await chrome.storage.local.get([
    keys.protectMode,
    keys.selectedEntry,
    keys.manifest,
    keys.boundary
  ]);
  STATE = {
    protectMode: !!stored[keys.protectMode],
    selectedEntry: stored[keys.selectedEntry] || null,
    manifest: stored[keys.manifest] || null,
    boundary: stored[keys.boundary] || null
  };
  console.log('[aptrust/bg] hydrated', {
    protectMode: STATE.protectMode,
    selectedDomain: STATE.selectedEntry && STATE.selectedEntry.canonicalDomain
  });
}

async function persistState() {
  const keys = CONFIG.storageKeys;
  await chrome.storage.local.set({
    [keys.protectMode]: STATE.protectMode,
    [keys.selectedEntry]: STATE.selectedEntry,
    [keys.manifest]: STATE.manifest,
    [keys.boundary]: STATE.boundary
  });
}

// ---------------------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------------------

async function serverSearch(q) {
  const url = `${CONFIG.indexServerBase}/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  return res.json();
}

async function serverEntry(domain) {
  const url = `${CONFIG.indexServerBase}/entry/${encodeURIComponent(domain)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`entry HTTP ${res.status}`);
  return res.json();
}

async function loadManifest(entry) {
  const res = await fetch(entry.manifestUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const text = await res.text();

  // SHA-256 scaffold — always compute, enforce only when configured.
  const digest = `sha256-${await sha256Hex(text)}`;
  const expected = entry.manifestHash;
  const enforcing =
    CONFIG.enforceHashVerification &&
    entry.hashVerificationEnabled === true &&
    expected &&
    expected !== 'sha256-pending';

  if (enforcing && digest !== expected) {
    // TODO (hash verification): hard-fail here once we're enforcing.
    throw new Error(`Manifest hash mismatch. expected=${expected} got=${digest}`);
  }
  console.log('[aptrust/bg] manifest digest', digest, 'expected', expected, 'enforcing', enforcing);

  const manifest = JSON.parse(text);
  return { manifest, digest };
}

// ---------------------------------------------------------------------------
// Public actions used by popup
// ---------------------------------------------------------------------------

async function setProtectMode(enabled) {
  STATE.protectMode = !!enabled;
  await persistState();
  await refreshBadgeForActiveTab();
}

async function selectBoundary(canonicalDomain) {
  const entry = await serverEntry(canonicalDomain);
  const { manifest } = await loadManifest(entry);
  const boundary = buildBoundary(manifest);

  STATE.selectedEntry = {
    canonicalDomain: entry.canonicalDomain,
    displayName: entry.displayName,
    manifestUrl: entry.manifestUrl,
    manifestHash: entry.manifestHash,
    hashVerificationEnabled: entry.hashVerificationEnabled,
    version: entry.version,
    txtSimulation: entry.txtSimulation
  };
  STATE.manifest = manifest;
  STATE.boundary = boundary;

  await persistState();
  await refreshBadgeForActiveTab();
  return { entry: STATE.selectedEntry, boundary };
}

async function clearBoundary() {
  STATE.selectedEntry = null;
  STATE.manifest = null;
  STATE.boundary = null;
  await persistState();
  await refreshBadgeForActiveTab();
}

// ---------------------------------------------------------------------------
// Evaluation / badge
// ---------------------------------------------------------------------------

function evaluate(url) {
  if (!STATE.protectMode) {
    return { status: STATUS.SKIPPED, reason: 'Protect Mode is off', matched: null };
  }
  return evaluateUrl(url, STATE.boundary, CONFIG);
}

/**
 * Page-context evaluation. Used for the TAB URL only, NOT for link batches.
 *
 * Rules:
 *   - If the pure evaluator returns TRUSTED or EXCLUDED, we leave it alone —
 *     those are real classifications (e.g. mail host declared in boundary,
 *     or explicitly excluded by the manifest).
 *   - If the pure evaluator returns UNTRUSTED and the tab host is a known
 *     webmail host (CONFIG.emailHosts), reclassify as MAIL_CLIENT. The page
 *     itself is not flagged; the content script shows a neutral banner and
 *     relies on the existing link-scan to outline hyperlinks whose targets
 *     fall outside the boundary.
 */
function evaluatePage(url) {
  const r = evaluate(url);
  if (r.status === STATUS.UNTRUSTED && STATE.boundary) {
    const host = extractHost(url);
    if (isEmailHost(host, CONFIG.emailHosts)) {
      const boundaryName =
        (STATE.boundary && STATE.boundary.canonicalDomain) || 'the selected boundary';
      return {
        status: STATUS.MAIL_CLIENT,
        reason:
          `Recognized email client (${host}). Hyperlinks in messages are still ` +
          `checked against ${boundaryName}.`,
        matched: host
      };
    }
  }
  return r;
}

function badgeFor(result) {
  switch (result.status) {
    case STATUS.TRUSTED:
      return { text: 'OK', color: '#2e7d32' };
    case STATUS.UNTRUSTED:
      return { text: '!', color: '#c62828' };
    case STATUS.EXCLUDED:
      return { text: 'X', color: '#ad1457' };
    case STATUS.MAIL_CLIENT:
      return { text: '✉', color: '#1976d2' };
    default:
      return { text: '', color: '#757575' };
  }
}

async function setBadge(tabId, result) {
  const b = badgeFor(result);
  try {
    await chrome.action.setBadgeText({ tabId, text: b.text });
    if (b.text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: b.color });
    }
    await chrome.action.setTitle({
      tabId,
      title: `APTrust — ${result.status}${result.reason ? `: ${result.reason}` : ''}`
    });
  } catch (_e) {
    // tab might have closed; ignore
  }
}

async function evaluateAndBadgeTab(tab) {
  if (!tab || !tab.id || !tab.url) return;
  const result = evaluatePage(tab.url);
  await setBadge(tab.id, result);

  // Tell the content script to show/hide the in-page banner for UNTRUSTED only.
  if (tab.url.startsWith('http://') || tab.url.startsWith('https://')) {
    chrome.tabs.sendMessage(
      tab.id,
      { type: 'APTRUST_PAGE_EVAL', result, boundary: boundarySummary() },
      () => void chrome.runtime.lastError // swallow "no receiver" noise
    );
  }
}

function boundarySummary() {
  if (!STATE.selectedEntry) return null;
  return {
    canonicalDomain: STATE.selectedEntry.canonicalDomain,
    displayName: STATE.selectedEntry.displayName,
    reportContact: (STATE.boundary && STATE.boundary.reportContact) || null
  };
}

async function refreshBadgeForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) await evaluateAndBadgeTab(tab);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => hydrateFromStorage());
chrome.runtime.onStartup.addListener(() => hydrateFromStorage());
// Also hydrate eagerly on worker spin-up.
hydrateFromStorage();

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await evaluateAndBadgeTab(tab);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    await evaluateAndBadgeTab(tab);
  }
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  chrome.tabs.get(details.tabId, (tab) => {
    if (!chrome.runtime.lastError && tab) evaluateAndBadgeTab(tab);
  });
});

/**
 * Redirect detection. We *observe* redirects and warn if the final destination
 * falls outside the boundary; we do NOT cancel or block.
 */
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.type !== 'main_frame') return;
    if (!STATE.protectMode || !STATE.boundary) return;
    const start = evaluateUrl(details.url, STATE.boundary, CONFIG);
    const end = evaluateUrl(details.redirectUrl, STATE.boundary, CONFIG);
    if (end.status === STATUS.UNTRUSTED || end.status === STATUS.EXCLUDED) {
      console.warn('[aptrust/bg] redirect leaves boundary', {
        from: details.url,
        to: details.redirectUrl,
        start,
        end
      });
      chrome.tabs.sendMessage(
        details.tabId,
        {
          type: 'APTRUST_REDIRECT_WARNING',
          from: details.url,
          to: details.redirectUrl,
          result: end
        },
        () => void chrome.runtime.lastError
      );
    }
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

// ---------------------------------------------------------------------------
// Message router (popup + content script)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'GET_STATE':
          sendResponse({
            ok: true,
            state: {
              protectMode: STATE.protectMode,
              selectedEntry: STATE.selectedEntry,
              boundary: STATE.boundary
            }
          });
          return;

        case 'SET_PROTECT_MODE':
          await setProtectMode(!!msg.enabled);
          sendResponse({ ok: true, protectMode: STATE.protectMode });
          return;

        case 'SEARCH':
          sendResponse({ ok: true, data: await serverSearch(msg.q || '') });
          return;

        case 'SELECT_BOUNDARY': {
          const data = await selectBoundary(msg.canonicalDomain);
          sendResponse({ ok: true, data });
          return;
        }

        case 'CLEAR_BOUNDARY':
          await clearBoundary();
          sendResponse({ ok: true });
          return;

        case 'EVALUATE_URL':
          // EVALUATE_URL is only used for the tab/page URL (popup + content
          // bootstrap). Use the page-context evaluator so mail clients are
          // softened to MAIL_CLIENT instead of UNTRUSTED.
          sendResponse({ ok: true, result: evaluatePage(msg.url) });
          return;

        case 'EVALUATE_URLS': {
          const urls = Array.isArray(msg.urls) ? msg.urls : [];
          const results = urls.map((u) => ({ url: u, result: evaluate(u) }));
          sendResponse({ ok: true, results });
          return;
        }

        case 'SUBMIT_REPORT': {
          // Forward the user-filled report to the local index server's mockup
          // endpoint. Content scripts can't always reach localhost directly
          // (page CSP), so we proxy through the service worker.
          const payload = {
            ...(msg.payload || {}),
            boundary: boundarySummary(),
            submittedAt: new Date().toISOString()
          };
          try {
            const r = await fetch(`${CONFIG.indexServerBase}/report`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const data = await r.json().catch(() => ({}));
            sendResponse({ ok: r.ok, status: r.status, data });
          } catch (err) {
            sendResponse({ ok: false, error: err.message || String(err) });
          }
          return;
        }

        case 'EVALUATE_ACTIVE_TAB': {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          const result = tab ? evaluate(tab.url) : { status: STATUS.SKIPPED, reason: 'No active tab' };
          sendResponse({ ok: true, tab: tab ? { id: tab.id, url: tab.url } : null, result });
          return;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg && msg.type}` });
      }
    } catch (err) {
      console.error('[aptrust/bg] message error', err);
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  return true; // keep the channel open for async sendResponse
});
