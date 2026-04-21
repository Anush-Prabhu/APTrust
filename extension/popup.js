/**
 * Popup controller. Talks to background via chrome.runtime.sendMessage.
 * No trust logic here; this is pure UI.
 */

import { STATUS } from './src/config.js';

const $ = (id) => document.getElementById(id);

const els = {
  protect: $('protectMode'),
  search: $('searchInput'),
  results: $('searchResults'),
  selectedBody: $('selectedBody'),
  clearBtn: $('clearBtn'),
  tabUrl: $('tabUrl'),
  tabVerdict: $('tabVerdict'),
  status: $('status')
};

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: 'no response' });
      }
    });
  });
}

function setStatus(text, kind = '') {
  els.status.textContent = text || '';
  els.status.className = 'status' + (kind ? ` ${kind}` : '');
}

function renderSelected(entry) {
  if (!entry) {
    els.selectedBody.textContent = 'None selected.';
    els.selectedBody.classList.add('muted');
    els.clearBtn.classList.add('hidden');
    return;
  }
  els.selectedBody.classList.remove('muted');
  els.selectedBody.innerHTML = `
    <div><strong>${escapeHtml(entry.displayName || entry.canonicalDomain)}</strong></div>
    <div class="mono small muted">${escapeHtml(entry.canonicalDomain)} · v${escapeHtml(entry.version || '?')}</div>
  `;
  els.clearBtn.classList.remove('hidden');
}

function renderVerdict(url, result) {
  els.tabUrl.textContent = url || '—';
  const cls = {
    [STATUS.TRUSTED]: 'ok',
    [STATUS.UNTRUSTED]: 'warn',
    [STATUS.EXCLUDED]: 'excl',
    [STATUS.SKIPPED]: 'skipped'
  }[result.status] || 'skipped';
  els.tabVerdict.className = `verdict ${cls}`;
  els.tabVerdict.textContent = `${result.status.toUpperCase()} — ${result.reason || ''}`;
}

function renderResults(list) {
  els.results.innerHTML = '';
  if (!list || list.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No matches.';
    els.results.appendChild(li);
    return;
  }
  list.forEach((item) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="name">${escapeHtml(item.displayName || item.canonicalDomain)}</div>
      <div class="domain">${escapeHtml(item.canonicalDomain)}</div>
    `;
    li.addEventListener('click', () => onPickBoundary(item.canonicalDomain));
    els.results.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function refreshState() {
  const res = await send('GET_STATE');
  if (!res.ok) {
    setStatus(`Error: ${res.error}`, 'err');
    return;
  }
  const { protectMode, selectedEntry } = res.state;
  els.protect.checked = !!protectMode;
  renderSelected(selectedEntry);

  const tabRes = await send('EVALUATE_ACTIVE_TAB');
  if (tabRes.ok) renderVerdict(tabRes.tab && tabRes.tab.url, tabRes.result);
}

async function onProtectToggle() {
  const res = await send('SET_PROTECT_MODE', { enabled: els.protect.checked });
  if (!res.ok) {
    setStatus(`Error: ${res.error}`, 'err');
    els.protect.checked = !els.protect.checked;
    return;
  }
  setStatus(res.protectMode ? 'Protect Mode ON' : 'Protect Mode OFF', 'ok');
  await refreshState();
}

let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = els.search.value.trim();
  if (!q) {
    els.results.innerHTML = '';
    return;
  }
  searchTimer = setTimeout(async () => {
    const res = await send('SEARCH', { q });
    if (!res.ok) {
      setStatus(`Search failed: ${res.error}`, 'err');
      return;
    }
    setStatus('');
    renderResults(res.data.results || []);
  }, 150);
}

async function onPickBoundary(canonicalDomain) {
  setStatus(`Loading ${canonicalDomain}…`);
  const res = await send('SELECT_BOUNDARY', { canonicalDomain });
  if (!res.ok) {
    setStatus(`Failed: ${res.error}`, 'err');
    return;
  }
  setStatus(`Loaded ${canonicalDomain}`, 'ok');
  els.results.innerHTML = '';
  els.search.value = '';
  await refreshState();
}

async function onClear() {
  await send('CLEAR_BOUNDARY');
  setStatus('Cleared.', 'ok');
  await refreshState();
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

els.protect.addEventListener('change', onProtectToggle);
els.search.addEventListener('input', onSearchInput);
els.clearBtn.addEventListener('click', onClear);

refreshState().catch((err) => setStatus(`Init error: ${err.message}`, 'err'));
