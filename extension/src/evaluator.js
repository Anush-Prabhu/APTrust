/**
 * Trust-boundary builder + evaluator.
 *
 *   buildBoundary(manifest)   ->  plain object safe for chrome.storage.local
 *   evaluateUrl(url, boundary, config)  ->  { status, reason, matched }
 */

import { CONFIG, STATUS } from './config.js';
import {
  parseUrl,
  extractHost,
  isSubdomainOf,
  canonicalizeUrl,
  canonicalizeSocialUrl,
  isSocialHost,
  stripWww
} from './normalize.js';

/**
 * Turn a freshly-fetched manifest into a normalized in-memory boundary.
 *
 * The manifest uses custom "aptrust:*" keys (JSON-LD) but the extension
 * doesn't do JSON-LD expansion; we just read the well-known keys directly.
 */
export function buildBoundary(manifest) {
  const trustedDomains = new Set();

  const addDomainFromUrl = (u) => {
    const host = extractHost(u);
    if (host) trustedDomains.add(host);
  };

  if (manifest.url) addDomainFromUrl(manifest.url);

  (manifest['aptrust:sameAsDomain'] || manifest.sameAsDomain || []).forEach(addDomainFromUrl);

  const tb = manifest['aptrust:trustBoundary'] || manifest.trustBoundary || {};
  if (tb.primaryDomain) trustedDomains.add(stripWww(tb.primaryDomain.toLowerCase()));
  (tb.additionalDomains || []).forEach((d) => trustedDomains.add(stripWww(String(d).toLowerCase())));

  // identifiers: [{propertyID:"aptrust:domain", value:"jhu.edu"}, ...]
  const identifiers = manifest.identifier || [];
  identifiers.forEach((id) => {
    if (id && typeof id === 'object' && id.value) {
      trustedDomains.add(stripWww(String(id.value).toLowerCase()));
    }
  });

  const socialProfiles = new Set(
    (manifest['aptrust:sameAsSocialProfile'] || manifest.sameAsSocialProfile || [])
      .map(canonicalizeSocialUrl)
      .filter(Boolean)
  );

  const additionalProfiles = new Set(
    (manifest['aptrust:sameAsAdditionalProfile'] || manifest.sameAsAdditionalProfile || [])
      .map((u) => canonicalizeUrl(u, { preserveQuery: false }))
      .filter(Boolean)
  );

  const exclusions = (manifest['aptrust:exclusion'] || manifest.exclusion || [])
    .map((e) => {
      if (typeof e === 'string') return { domain: stripWww(e.toLowerCase()), reason: '' };
      if (e && e.domain) {
        return { domain: stripWww(String(e.domain).toLowerCase()), reason: e.reason || '' };
      }
      return null;
    })
    .filter(Boolean);

  const reportContact = manifest['aptrust:reportContact'] || manifest.reportContact || null;

  return {
    canonicalDomain:
      (tb.primaryDomain && stripWww(tb.primaryDomain.toLowerCase())) ||
      (manifest.url && extractHost(manifest.url)) ||
      null,
    displayName: manifest.name || null,
    trustedDomains: [...trustedDomains],
    socialProfiles: [...socialProfiles],
    additionalProfiles: [...additionalProfiles],
    exclusions,
    reportContact
  };
}

/**
 * Evaluate a URL against a boundary. Pure function; no side effects.
 * Returns one of: trusted, untrusted, excluded, skipped.
 */
export function evaluateUrl(urlString, boundary, config = CONFIG) {
  if (!boundary) {
    return { status: STATUS.SKIPPED, reason: 'No trust boundary selected', matched: null };
  }

  const u = parseUrl(urlString);
  if (!u) {
    return { status: STATUS.SKIPPED, reason: 'Not an http(s) URL', matched: null };
  }

  const host = extractHost(u);
  if (!host) {
    return { status: STATUS.SKIPPED, reason: 'No hostname', matched: null };
  }

  // 1. Exclusions always win.
  for (const ex of boundary.exclusions || []) {
    if (isSubdomainOf(host, ex.domain)) {
      return {
        status: STATUS.EXCLUDED,
        reason: ex.reason || `Excluded by manifest: ${ex.domain}`,
        matched: ex.domain
      };
    }
  }

  // 2. Social hosts: accept the declared profile URL or any sub-path under it
  //    (spec rule: "exact URL / exact account path match"). A sub-path is a
  //    page belonging to the same account, e.g. a profile's /related_profiles,
  //    /tagged, /status/<id>, /about, etc. We only admit sub-paths at a path
  //    segment boundary so "johnshopkinsu" never matches "johnshopkinsuhelp".
  if (isSocialHost(host, config.socialHosts)) {
    const visited = canonicalizeSocialUrl(u);
    if (visited) {
      for (const declared of boundary.socialProfiles || []) {
        if (socialProfileMatches(visited, declared)) {
          return {
            status: STATUS.TRUSTED,
            reason:
              visited === declared
                ? 'Exact social-profile match'
                : `Sub-path of declared social profile (${declared})`,
            matched: declared
          };
        }
      }
    }
    return {
      status: STATUS.UNTRUSTED,
      reason: 'Social-platform host without a declared profile / account-path match',
      matched: host
    };
  }

  // 3. Additional profiles: exact URL match.
  const canon = canonicalizeUrl(u, { preserveQuery: false });
  if (canon && (boundary.additionalProfiles || []).includes(canon)) {
    return { status: STATUS.TRUSTED, reason: 'Exact additional-profile match', matched: canon };
  }

  // 4. Trusted domains: exact or subdomain.
  for (const d of boundary.trustedDomains || []) {
    if (isSubdomainOf(host, d)) {
      return {
        status: STATUS.TRUSTED,
        reason: host === d ? `Exact domain match: ${d}` : `Subdomain of ${d}`,
        matched: d
      };
    }
  }

  return {
    status: STATUS.UNTRUSTED,
    reason: `${host} is outside the selected trust boundary`,
    matched: host
  };
}

/**
 * Social-profile matcher. True iff `visited` is the declared profile URL or a
 * sub-path of it at a path-segment boundary.
 *
 *   declared = "https://instagram.com/johnshopkinsu"
 *   visited  = "https://instagram.com/johnshopkinsu"              -> true (exact)
 *   visited  = "https://instagram.com/johnshopkinsu/tagged"       -> true (sub-path)
 *   visited  = "https://instagram.com/johnshopkinsuhelp"          -> false (prefix, no /)
 *   visited  = "https://instagram.com/OtherAccount"               -> false (different path)
 *
 * Inputs must already be canonicalized (host-lowercased, www-stripped, no
 * trailing slash, no query). canonicalizeSocialUrl produces that form.
 */
function socialProfileMatches(visited, declared) {
  if (!visited || !declared) return false;
  if (visited === declared) return true;
  return visited.startsWith(declared + '/');
}

/**
 * SHA-256 scaffold. Called against raw manifest text.
 *
 * TODO (hash verification):
 *   When CONFIG.enforceHashVerification === true and entries.json ships a real
 *   `sha256-<hex>` value, reject manifests whose computed digest doesn't match.
 *   Today this runs, logs, and returns the digest but does not block.
 */
export async function sha256Hex(text) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
