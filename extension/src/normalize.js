/**
 * URL/domain normalization helpers. No browser-specific APIs here so the
 * module can be unit-tested with plain Node if needed.
 */

/** Return a URL object or null if the string is not a parseable http(s) URL. */
export function parseUrl(input) {
  if (!input || typeof input !== 'string') return null;
  try {
    const u = new URL(input);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

/** Lowercased hostname with any leading "www." removed. */
export function extractHost(input) {
  const u = typeof input === 'string' ? parseUrl(input) : input;
  if (!u) return null;
  return stripWww(u.hostname.toLowerCase());
}

export function stripWww(host) {
  if (!host) return host;
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * True if `host` is exactly `parent` or a subdomain of `parent`.
 * Both sides are compared lowercase, with "www." already stripped by callers.
 */
export function isSubdomainOf(host, parent) {
  if (!host || !parent) return false;
  if (host === parent) return true;
  return host.endsWith('.' + parent);
}

/**
 * Canonicalize a URL for exact-match comparisons.
 *   - lowercase scheme + host
 *   - strip "www."
 *   - strip trailing slash from path (unless path is "/")
 *   - drop hash; keep search for additional profiles (social usually has none)
 *   - keep path case-sensitive (social handles are case-sensitive per the spec)
 */
export function canonicalizeUrl(input, { preserveQuery = true } = {}) {
  const u = typeof input === 'string' ? parseUrl(input) : input;
  if (!u) return null;

  const host = stripWww(u.hostname.toLowerCase());
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const scheme = u.protocol.toLowerCase();
  const query = preserveQuery && u.search ? u.search : '';
  return `${scheme}//${host}${path}${query}`;
}

/** Canonical form for social-profile comparison (no query, no trailing slash). */
export function canonicalizeSocialUrl(input) {
  return canonicalizeUrl(input, { preserveQuery: false });
}

/** True if this host is a social-platform host we treat specially. */
export function isSocialHost(host, socialHosts) {
  if (!host) return false;
  const h = stripWww(host.toLowerCase());
  return socialHosts.some((s) => h === s || h.endsWith('.' + s));
}

/**
 * True if this host is a known webmail / email-client host.
 * Used by the background to soften the page verdict for mail clients so the
 * whole tab isn't flagged as "outside trust boundary" just because the user
 * is reading mail (mail.google.com, outlook.live.com, etc.).
 */
export function isEmailHost(host, emailHosts) {
  if (!host) return false;
  const h = stripWww(host.toLowerCase());
  return (emailHosts || []).some((m) => {
    const mm = stripWww(String(m).toLowerCase());
    return h === mm || h.endsWith('.' + mm);
  });
}
