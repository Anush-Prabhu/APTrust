/**
 * Content script — runs in the page context for every http(s) page.
 *
 * Responsibilities:
 *   1. Scan <a href> links on the page and request evaluation from the
 *      background worker; tag untrusted links visually.
 *   2. Listen for paste events and evaluate any URLs found in the pasted text.
 *   3. Show an in-page banner when the background flags the current page
 *      as UNTRUSTED or EXCLUDED, or when a redirect leaves the boundary.
 *
 * Important: we ONLY warn. We never preventDefault or block navigation.
 */

(() => {
  if (window.__aptrustContentLoaded) return;
  window.__aptrustContentLoaded = true;

  const STATUS = {
    TRUSTED: 'trusted',
    UNTRUSTED: 'untrusted',
    EXCLUDED: 'excluded',
    SKIPPED: 'skipped',
    MAIL_CLIENT: 'mail_client'
  };

  const BANNER_ID = 'aptrust-banner-root';
  const MODAL_ID = 'aptrust-modal-root';
  const LINK_MARK_ATTR = 'data-aptrust-mark';

  // Last known boundary summary (canonicalDomain, displayName, reportContact).
  // Refreshed whenever APTRUST_PAGE_EVAL arrives. Used to label the Report
  // button with "Report to <domain>" and to fill the modal header.
  let lastBoundary = null;
  let lastPageResult = null;

  // Page-level verdict, updated whenever the background re-evaluates this tab.
  // Starts OPTIMISTIC (unknown) — link scans pre-PAGE_EVAL behave like the old
  // "mark everything untrusted" behavior until we learn the page is trusted.
  let pageStatus = null; // 'trusted' | 'untrusted' | 'excluded' | 'skipped' | null
  const pageHost = (location.host || '').toLowerCase().replace(/^www\./, '');

  function hostOf(u) {
    try { return new URL(u).host.toLowerCase().replace(/^www\./, ''); }
    catch { return ''; }
  }

  // -------------------------------------------------------------------------
  // Banner
  // -------------------------------------------------------------------------

  function ensureBanner() {
    let root = document.getElementById(BANNER_ID);
    if (root) return root;
    root = document.createElement('div');
    root.id = BANNER_ID;
    root.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:2147483647',
      'font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial',
      'pointer-events:none'
    ].join(';');
    (document.documentElement || document.body).appendChild(root);
    return root;
  }

  function showBanner({ kind, title, detail, showReport }) {
    const root = ensureBanner();
    root.innerHTML = '';
    const bar = document.createElement('div');
    const bg =
      kind === 'excluded' ? '#ad1457'
      : kind === 'info'   ? '#1976d2'
      :                     '#c62828';
    bar.style.cssText = [
      `background:${bg}`,
      'color:#fff',
      'padding:8px 12px',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'box-shadow:0 2px 6px rgba(0,0,0,0.25)',
      'pointer-events:auto'
    ].join(';');

    const btnStyle =
      'background:transparent;border:1px solid rgba(255,255,255,.6);' +
      'color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit';

    const reportLabel =
      showReport && lastBoundary && lastBoundary.canonicalDomain
        ? `Report to ${lastBoundary.canonicalDomain}`
        : 'Report';

    bar.innerHTML = `
      <strong style="flex:0 0 auto">APTrust</strong>
      <span style="flex:1 1 auto">
        <span style="font-weight:600">${escapeHtml(title)}</span>
        ${detail ? `<span style="opacity:.9"> — ${escapeHtml(detail)}</span>` : ''}
      </span>
      ${
        showReport
          ? `<button type="button" data-aptrust-action="report" style="${btnStyle};background:rgba(255,255,255,.12)">${escapeHtml(reportLabel)}</button>`
          : ''
      }
      <button type="button" data-aptrust-action="dismiss" style="${btnStyle}">Dismiss</button>
    `;

    bar.querySelector('[data-aptrust-action="dismiss"]').addEventListener('click', () => {
      root.innerHTML = '';
    });
    const reportBtn = bar.querySelector('[data-aptrust-action="report"]');
    if (reportBtn) {
      reportBtn.addEventListener('click', () => openReportModal());
    }

    root.appendChild(bar);
  }

  function clearBanner() {
    const root = document.getElementById(BANNER_ID);
    if (root) root.innerHTML = '';
  }

  // ---------------------------------------------------------------------------
  // Report modal (mockup). Collects a reason, POSTs through the background
  // service worker to /report, and shows a confirmation state.
  // ---------------------------------------------------------------------------

  function closeReportModal() {
    const root = document.getElementById(MODAL_ID);
    if (root) root.remove();
  }

  function openReportModal() {
    closeReportModal();

    const boundary = lastBoundary || {};
    const canonical = boundary.canonicalDomain || '(no boundary selected)';
    const displayName = boundary.displayName || canonical;
    const contact = boundary.reportContact || null;
    const flaggedUrl = location.href;
    const flaggedReason = (lastPageResult && lastPageResult.reason) || '';

    const root = document.createElement('div');
    root.id = MODAL_ID;
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'background:rgba(10,12,16,.55)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial',
      'color:#e7eaf0'
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'background:#171a21',
      'border:1px solid #2a2f3a',
      'border-radius:10px',
      'padding:18px 18px 14px',
      'width:min(520px, calc(100vw - 32px))',
      'box-shadow:0 20px 60px rgba(0,0,0,.5)'
    ].join(';');

    const contactBlock = contact
      ? `
        <div style="margin-top:10px;padding:8px 10px;background:#0b0d12;border:1px solid #2a2f3a;border-radius:6px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#9aa3b2;margin-bottom:4px">Report contact</div>
          ${contact.team ? `<div><strong>${escapeHtml(contact.team)}</strong></div>` : ''}
          ${contact.email ? `<div>Email: <code>${escapeHtml(contact.email)}</code></div>` : ''}
          ${contact.url ? `<div>Web: <code>${escapeHtml(contact.url)}</code></div>` : ''}
          ${contact.note ? `<div style="color:#9aa3b2;margin-top:4px">${escapeHtml(contact.note)}</div>` : ''}
        </div>`
      : `<div style="margin-top:10px;color:#9aa3b2">No report contact declared in the manifest. The POC will log this report to the local index server.</div>`;

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <strong style="color:#ffb4b4">APTrust · Report</strong>
        <span style="flex:1"></span>
        <button type="button" data-aptrust-modal="close" aria-label="Close"
          style="background:transparent;border:1px solid #2a2f3a;color:#9aa3b2;border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit">×</button>
      </div>
      <div style="font-size:15px;font-weight:600;margin-bottom:6px">
        Report suspected impersonation of ${escapeHtml(displayName)}
      </div>
      <div style="color:#9aa3b2;margin-bottom:10px">
        This will be filed against the boundary <code>${escapeHtml(canonical)}</code>.
      </div>

      <div style="padding:8px 10px;background:#0b0d12;border:1px solid #2a2f3a;border-radius:6px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#9aa3b2;margin-bottom:4px">Flagged page</div>
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all">${escapeHtml(flaggedUrl)}</div>
        ${flaggedReason ? `<div style="color:#9aa3b2;margin-top:6px">Verdict reason: ${escapeHtml(flaggedReason)}</div>` : ''}
      </div>

      ${contactBlock}

      <label style="display:block;margin-top:12px;margin-bottom:4px;color:#9aa3b2">Reason (optional)</label>
      <textarea data-aptrust-modal="reason" rows="3"
        placeholder="e.g. typosquat of jhu.edu; page asks for student credentials"
        style="width:100%;box-sizing:border-box;background:#0b0d12;color:#e7eaf0;border:1px solid #2a2f3a;border-radius:6px;padding:8px 10px;font:inherit;resize:vertical"></textarea>

      <div data-aptrust-modal="status" style="min-height:1.2em;margin-top:8px;color:#a5d6a7"></div>

      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
        <button type="button" data-aptrust-modal="cancel"
          style="background:transparent;color:#9aa3b2;border:1px solid #2a2f3a;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit">Cancel</button>
        <button type="button" data-aptrust-modal="submit"
          style="background:#c62828;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;font-weight:600">Send report</button>
      </div>

      <div style="margin-top:10px;color:#677084;font-size:11px">
        Mockup: this POC sends the report to the local index server at <code>/report</code>, which logs it.
      </div>
    `;

    root.appendChild(card);
    (document.documentElement || document.body).appendChild(root);

    // dismiss on overlay click (but not card click)
    root.addEventListener('click', (e) => {
      if (e.target === root) closeReportModal();
    });
    card.querySelector('[data-aptrust-modal="close"]').addEventListener('click', closeReportModal);
    card.querySelector('[data-aptrust-modal="cancel"]').addEventListener('click', closeReportModal);

    const submitBtn = card.querySelector('[data-aptrust-modal="submit"]');
    const statusEl = card.querySelector('[data-aptrust-modal="status"]');
    const reasonEl = card.querySelector('[data-aptrust-modal="reason"]');

    submitBtn.addEventListener('click', () => {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      statusEl.textContent = '';

      const payload = {
        url: flaggedUrl,
        reason: (reasonEl.value || '').trim(),
        pageResult: lastPageResult || null
      };

      chrome.runtime.sendMessage({ type: 'SUBMIT_REPORT', payload }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send report';
          statusEl.style.color = '#ffb4b4';
          statusEl.textContent =
            'Could not send: ' +
            ((chrome.runtime.lastError && chrome.runtime.lastError.message) ||
              (res && res.error) ||
              'unknown error');
          return;
        }
        statusEl.style.color = '#a5d6a7';
        const id = res.data && res.data.id ? ` (id: ${res.data.id})` : '';
        const msg = (res.data && res.data.message) || 'Report filed (mockup).';
        statusEl.textContent = `${msg}${id}`;
        submitBtn.textContent = 'Sent';
        submitBtn.style.background = '#2e7d32';
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // -------------------------------------------------------------------------
  // Background messages (page-level verdicts)
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'APTRUST_PAGE_EVAL') {
      const r = msg.result || {};
      pageStatus = r.status || null;
      lastPageResult = r;
      if (msg.boundary) lastBoundary = msg.boundary;
      const showReport = !!(lastBoundary && lastBoundary.canonicalDomain);
      if (r.status === STATUS.UNTRUSTED) {
        showBanner({
          kind: 'untrusted',
          title: 'This page is outside the selected trust boundary',
          detail: r.reason || '',
          showReport
        });
      } else if (r.status === STATUS.EXCLUDED) {
        showBanner({
          kind: 'excluded',
          title: 'This page is explicitly excluded by the manifest',
          detail: r.reason || '',
          showReport
        });
      } else if (r.status === STATUS.MAIL_CLIENT) {
        const boundaryLabel =
          (lastBoundary && lastBoundary.canonicalDomain) || 'the selected boundary';
        showBanner({
          kind: 'info',
          title: `Email client detected — hyperlinks going outside ${boundaryLabel} will be flagged`,
          detail: r.reason || ''
        });
        // Same-host mail UI chrome (compose, labels, sidebar) is noise if we
        // paint it red. Clear any prior outlines the pre-verdict scan left.
        repaintSameHostLinks();
        scheduleSenderScan();
      } else {
        clearBanner();
        // Page flipped to trusted — clear stale red outlines on same-host links.
        repaintSameHostLinks();
      }
      return;
    }

    if (msg.type === 'APTRUST_REDIRECT_WARNING') {
      const showReport = !!(lastBoundary && lastBoundary.canonicalDomain);
      showBanner({
        kind: 'untrusted',
        title: 'Redirect left the trust boundary',
        detail: `${shortUrl(msg.from)} → ${shortUrl(msg.to)}`,
        showReport
      });
      return;
    }
  });

  function shortUrl(u) {
    try { const p = new URL(u); return p.host + p.pathname; }
    catch { return String(u); }
  }

  // -------------------------------------------------------------------------
  // Link scanning (batched)
  // -------------------------------------------------------------------------

  function collectLinks() {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const urls = new Set();
    const byUrl = new Map(); // url -> [elements]
    for (const a of anchors) {
      if (a.hasAttribute(LINK_MARK_ATTR)) continue;
      const href = a.href;
      if (!href) continue;
      if (!/^https?:/i.test(href)) continue;
      if (!byUrl.has(href)) byUrl.set(href, []);
      byUrl.get(href).push(a);
      urls.add(href);
    }
    return { urls: [...urls], byUrl };
  }

  /**
   * Should an untrusted link visually scream, or sit silently with tooltip
   * only? On a TRUSTED page, same-host links are platform chrome (think
   * Instagram's /accounts/login, story highlights, related-profiles grid) and
   * painting them red overwhelms the user. We still tag them via data-attr
   * and tooltip so the info is accessible; we just skip the outline.
   *
   * The same rule applies on MAIL_CLIENT pages: Gmail's compose/labels/etc.
   * belong to mail.google.com and shouldn't be outlined just because the
   * mail host isn't inside the jhu.edu boundary. Links in the email body
   * that point to OTHER hosts (the actually interesting case) are cross-host
   * and still get outlined.
   *
   * Cross-host untrusted links always get the outline — those are genuine
   * "leaving the declared boundary" signals.
   */
  function shouldOutline(linkUrl) {
    const linkHost = hostOf(linkUrl);
    if (!linkHost) return true;
    const samePageHost =
      pageStatus === STATUS.TRUSTED || pageStatus === STATUS.MAIL_CLIENT;
    if (samePageHost && linkHost === pageHost) return false;
    return true;
  }

  function applyLinkMark(elements, status, linkUrl) {
    if (!elements) return;
    const outlineNow = (status === STATUS.UNTRUSTED || status === STATUS.EXCLUDED)
      && shouldOutline(linkUrl);
    for (const el of elements) {
      el.setAttribute(LINK_MARK_ATTR, status);
      if (outlineNow) {
        el.style.outline = '2px dashed #c62828';
        el.style.outlineOffset = '2px';
        const existingTitle = el.getAttribute('title') || '';
        const note = 'APTrust: outside trust boundary';
        if (!existingTitle.includes(note)) {
          el.setAttribute('title', existingTitle ? `${existingTitle} · ${note}` : note);
        }
      } else if (status === STATUS.UNTRUSTED || status === STATUS.EXCLUDED) {
        // Same-host untrusted on a trusted page: drop any prior outline but
        // keep data-attr + tooltip for accessibility.
        el.style.outline = '';
        el.style.outlineOffset = '';
        const existingTitle = el.getAttribute('title') || '';
        const note = 'APTrust: outside trust boundary';
        if (!existingTitle.includes(note)) {
          el.setAttribute('title', existingTitle ? `${existingTitle} · ${note}` : note);
        }
      }
    }
  }

  /**
   * When the page verdict flips to TRUSTED or MAIL_CLIENT, remove outlines
   * from same-host untrusted links that were painted during an earlier scan.
   */
  function repaintSameHostLinks() {
    const anchors = document.querySelectorAll(`a[${LINK_MARK_ATTR}="untrusted"], a[${LINK_MARK_ATTR}="excluded"]`);
    anchors.forEach((el) => {
      const href = el.href || '';
      if (hostOf(href) === pageHost) {
        el.style.outline = '';
        el.style.outlineOffset = '';
      }
    });
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanLinks();
    }, 300);
  }

  function scanLinks() {
    const { urls, byUrl } = collectLinks();
    if (urls.length === 0) return;
    // Chunk into batches of 200 to keep messages small.
    const BATCH = 200;
    for (let i = 0; i < urls.length; i += BATCH) {
      const slice = urls.slice(i, i + BATCH);
      chrome.runtime.sendMessage({ type: 'EVALUATE_URLS', urls: slice }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) return;
        for (const { url, result } of res.results) {
          applyLinkMark(byUrl.get(url), result.status, url);
        }
      });
    }
  }

  // Initial + mutations
  scheduleScan();
  const mo = new MutationObserver(() => {
    scheduleScan();
    scheduleSenderScan();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // -------------------------------------------------------------------------
  // Email sender scanning (mail-client pages only).
  //
  // When we're on a recognized mail client (pageStatus === MAIL_CLIENT), we
  // scan the DOM for sender addresses and annotate them with a chip indicating
  // whether the sender's domain is inside the selected trust boundary.
  //
  // Two sources:
  //   1) Angle-bracket sender text like "Bloomberg Green<noreply@news.bloomberg.com>"
  //      — covers Outlook's reading-pane sender rendering.
  //   2) <a href="mailto:...">                 — covers Gmail and most others.
  //
  // Evaluation is routed through the existing EVALUATE_URLS message using a
  // pseudo-URL (`https://<sender-domain>/`) so the normal boundary logic
  // (trustedDomains / subdomain match / exclusions) does the work. No new
  // evaluator branch needed.
  // -------------------------------------------------------------------------

  const SENDER_EMAIL_RE = /<([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})>/;
  const CHIP_ATTR = 'data-aptrust-sender-chip';
  const chippedEls = new WeakSet();

  let senderScanScheduled = false;
  function scheduleSenderScan() {
    if (pageStatus !== STATUS.MAIL_CLIENT) return;
    if (senderScanScheduled) return;
    senderScanScheduled = true;
    setTimeout(() => {
      senderScanScheduled = false;
      scanSenders();
    }, 300);
  }

  function collectSenderTargets() {
    // Returns Map<email_lowercased, Element[]> — the element is the parent we
    // attach a chip next to. De-dupes per-element via chippedEls WeakSet.
    const byEmail = new Map();

    // (1) mailto: anchors
    const anchors = document.querySelectorAll('a[href^="mailto:"]');
    for (const a of anchors) {
      if (chippedEls.has(a)) continue;
      const raw = (a.getAttribute('href') || '').slice(7);
      const email = raw.split('?')[0].trim().toLowerCase();
      if (!email || !email.includes('@')) continue;
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(a);
    }

    // (2) angle-bracket sender text in leaf text nodes
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue || n.nodeValue.length < 5) return NodeFilter.FILTER_REJECT;
          if (n.nodeValue.indexOf('@') < 0) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let node;
      while ((node = walker.nextNode())) {
        const m = node.nodeValue.match(SENDER_EMAIL_RE);
        if (!m) continue;
        const email = m[1].toLowerCase();
        const parent = node.parentElement;
        if (!parent || chippedEls.has(parent)) continue;
        if (!byEmail.has(email)) byEmail.set(email, []);
        byEmail.get(email).push(parent);
      }
    } catch (_e) {
      // document.body may be unavailable very early — next mutation will retry.
    }

    return { byEmail };
  }

  function domainOf(email) {
    const at = email.lastIndexOf('@');
    return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
  }

  function buildChip(verdict, domain) {
    const chip = document.createElement('span');
    chip.setAttribute(CHIP_ATTR, verdict);
    const isUntrusted = verdict === 'untrusted' || verdict === 'excluded';
    chip.textContent = isUntrusted
      ? `APTrust: sender outside ${(lastBoundary && lastBoundary.canonicalDomain) || 'boundary'}`
      : `APTrust: sender in ${(lastBoundary && lastBoundary.canonicalDomain) || 'boundary'}`;
    chip.title = `Sender domain: ${domain}`;
    chip.style.cssText = [
      'display:inline-block',
      'margin:0 6px',
      'padding:1px 8px',
      'border-radius:10px',
      'font:11px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial',
      'vertical-align:middle',
      'color:#fff',
      'pointer-events:auto',
      `background:${isUntrusted ? '#c62828' : '#2e7d32'}`
    ].join(';');
    return chip;
  }

  function scanSenders() {
    if (pageStatus !== STATUS.MAIL_CLIENT) return;
    const { byEmail } = collectSenderTargets();
    const uniqueEmails = [...byEmail.keys()];
    if (uniqueEmails.length === 0) return;

    // Convert each sender to a pseudo-URL (`https://<domain>/`) and reuse the
    // existing boundary evaluator on the background side.
    const domainByEmail = new Map();
    const urls = [];
    for (const e of uniqueEmails) {
      const d = domainOf(e);
      if (!d) continue;
      domainByEmail.set(e, d);
      urls.push(`https://${d}/`);
    }
    if (urls.length === 0) return;

    chrome.runtime.sendMessage({ type: 'EVALUATE_URLS', urls }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) return;
      const verdictByDomain = new Map();
      for (const { url, result } of res.results) {
        try {
          const h = new URL(url).host.toLowerCase().replace(/^www\./, '');
          verdictByDomain.set(h, result.status);
        } catch (_e) {}
      }
      for (const email of uniqueEmails) {
        const domain = domainByEmail.get(email);
        const status = verdictByDomain.get(domain) || 'skipped';
        const elements = byEmail.get(email) || [];
        for (const el of elements) {
          if (chippedEls.has(el)) continue;
          if (!el.parentNode) continue;
          const chip = buildChip(status, domain);
          try {
            el.parentNode.insertBefore(chip, el.nextSibling);
            chippedEls.add(el);
          } catch (_e) {}
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Paste detection
  // -------------------------------------------------------------------------

  const URL_RE = /https?:\/\/[^\s<>"'`)]+/gi;

  document.addEventListener(
    'paste',
    (e) => {
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!text) return;
      const matches = text.match(URL_RE);
      if (!matches || matches.length === 0) return;
      const urls = [...new Set(matches)];
      chrome.runtime.sendMessage({ type: 'EVALUATE_URLS', urls }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) return;
        const bad = res.results.filter(
          (r) => r.result.status === STATUS.UNTRUSTED || r.result.status === STATUS.EXCLUDED
        );
        if (bad.length === 0) return;
        const first = bad[0];
        showBanner({
          kind: first.result.status === STATUS.EXCLUDED ? 'excluded' : 'untrusted',
          title: `Pasted URL outside trust boundary${bad.length > 1 ? ` (+${bad.length - 1} more)` : ''}`,
          detail: shortUrl(first.url)
        });
      });
    },
    true
  );

  // Ask the background for an initial verdict on this page so the banner
  // can appear even if the onUpdated event fired before we were injected.
  // Also seeds pageStatus so the very first link-scan can use the right policy.
  // We piggy-back on GET_STATE to pull the boundary summary so the Report
  // button can show "Report to <canonicalDomain>" without waiting for a
  // later APTRUST_PAGE_EVAL message.
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (stateRes) => {
    if (!chrome.runtime.lastError && stateRes && stateRes.ok && stateRes.state) {
      const entry = stateRes.state.selectedEntry;
      const b = stateRes.state.boundary;
      if (entry) {
        lastBoundary = {
          canonicalDomain: entry.canonicalDomain,
          displayName: entry.displayName,
          reportContact: (b && b.reportContact) || null
        };
      }
    }

    chrome.runtime.sendMessage(
      { type: 'EVALUATE_URL', url: location.href },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) return;
        const r = res.result || {};
        pageStatus = r.status || null;
        lastPageResult = r;
        const showReport = !!(lastBoundary && lastBoundary.canonicalDomain);
        if (r.status === STATUS.UNTRUSTED) {
          showBanner({
            kind: 'untrusted',
            title: 'This page is outside the selected trust boundary',
            detail: r.reason || '',
            showReport
          });
        } else if (r.status === STATUS.EXCLUDED) {
          showBanner({
            kind: 'excluded',
            title: 'This page is explicitly excluded by the manifest',
            detail: r.reason || '',
            showReport
          });
        } else if (r.status === STATUS.MAIL_CLIENT) {
          const boundaryLabel =
            (lastBoundary && lastBoundary.canonicalDomain) || 'the selected boundary';
          showBanner({
            kind: 'info',
            title: `Email client detected — hyperlinks going outside ${boundaryLabel} will be flagged`,
            detail: r.reason || ''
          });
          repaintSameHostLinks();
          scheduleSenderScan();
        } else if (r.status === STATUS.TRUSTED) {
          repaintSameHostLinks();
        }
      }
    );
  });
})();
