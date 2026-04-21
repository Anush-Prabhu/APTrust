/**
 * Central config for the extension. Kept tiny on purpose.
 *
 * NOTE: In MV3 with "type": "module", these exports can be imported from the
 * background service worker, the popup, and injected modules alike.
 */

export const CONFIG = {
  indexServerBase: 'http://localhost:8787',

  // TODO (hash verification):
  //   Flip this to `true` once entries.json has a real sha256-<hex> value and
  //   the manifest is frozen. The SHA-256 pipeline already runs; it's just
  //   not enforced. See background.js -> loadManifest().
  enforceHashVerification: false,

  // Hosts that are social platforms. For these hosts we refuse to trust the
  // whole domain; only exact profile URLs declared in the manifest are trusted.
  socialHosts: [
    'x.com',
    'twitter.com',
    'facebook.com',
    'm.facebook.com',
    'linkedin.com',
    'youtube.com',
    'm.youtube.com',
    'instagram.com',
    'tiktok.com',
    'threads.net',
    'reddit.com'
  ],

  // Known webmail / email-client hosts. When the TAB itself is on one of these
  // hosts, we do NOT flag the whole page as untrusted — the user is in a
  // legitimate mail client, not on an impersonation target. We still evaluate
  // every hyperlink inside the email against the selected trust boundary, so
  // links pointing outside the boundary are still outlined and tooltip-tagged.
  //
  // Matching is host-based with subdomain support (isSubdomainOf).
  emailHosts: [
    'mail.google.com',
    'outlook.live.com',
    'outlook.office.com',
    'outlook.office365.com',
    'outlook.cloud.microsoft', // JHU (and other tenants) use this host with ?realm=<tenant>
    'mail.yahoo.com',
    'mail.proton.me',
    'mail.aol.com',
    'mail.zoho.com',
    'app.fastmail.com',
    'icloud.com' // iCloud Mail is served under /mail on www.icloud.com
  ],

  storageKeys: {
    protectMode: 'aptrust.protectMode',
    selectedEntry: 'aptrust.selectedEntry',
    manifest: 'aptrust.manifest',
    boundary: 'aptrust.boundary'
  }
};

export const STATUS = {
  TRUSTED: 'trusted',
  UNTRUSTED: 'untrusted',
  EXCLUDED: 'excluded',
  SKIPPED: 'skipped',
  // Page-level only: the TAB URL is on a known webmail host. Set by the
  // background's evaluatePage(); never emitted by the pure evaluateUrl().
  MAIL_CLIENT: 'mail_client'
};
