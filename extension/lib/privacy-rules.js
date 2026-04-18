/**
 * Privacy rules - decides whether screenshot capture is allowed for a given URL.
 *
 * The blocklist uses suffix-matching so 'chase.com' also blocks 'secure.chase.com'.
 * Users can add their own domains in settings.
 */

/**
 * Returns true if the given URL matches any domain in the blocklist.
 * @param {string} url - Full page URL
 * @param {string[]} blockedDomains - List of blocked domain strings
 */
export function isDomainBlocked(url, blockedDomains = []) {
  if (!url) return false;

  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // Unparseable URL - don't block
  }

  return blockedDomains.some((domain) => {
    const d = domain.trim().toLowerCase();
    if (!d) return false;
    // Exact match or subdomain match
    return hostname === d || hostname.endsWith(`.${d}`);
  });
}

/**
 * Returns a human-readable reason why a URL is blocked, or null if it isn't.
 * @param {string} url
 * @param {string[]} blockedDomains
 * @returns {{ blocked: boolean, reason?: string, hostname?: string }}
 */
export function getPrivacyStatus(url, blockedDomains = []) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
    return {
      blocked: true,
      reason: 'Browser internal page - screenshots unavailable',
      category: 'internal',
    };
  }

  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
    return {
      blocked: true,
      reason: 'Non-web page - screenshots unavailable',
      category: 'internal',
    };
  }

  // file:// URLs have no hostname - skip domain blocklist check
  if (url.startsWith('file://')) return { blocked: false };

  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { blocked: false };
  }

  const matchedDomain = blockedDomains.find((domain) => {
    const d = domain.trim().toLowerCase();
    return d && (hostname === d || hostname.endsWith(`.${d}`));
  });

  if (matchedDomain) {
    return {
      blocked: true,
      reason: `Screenshots disabled on ${hostname} (privacy protection)`,
      category: 'blocklist',
      matchedDomain,
    };
  }

  return { blocked: false, hostname };
}

/**
 * Detect common sensitive page patterns even outside the explicit blocklist.
 * Returns a warning string if suspicious, or null.
 */
export function detectSensitivePattern(url, title = '') {
  const sensitiveKeywords = ['password', 'login', 'signin', 'auth', 'account', 'banking', 'payment', 'checkout'];
  const combined = (url + ' ' + title).toLowerCase();
  const matched = sensitiveKeywords.find((kw) => combined.includes(kw));
  return matched ? matched : null;
}
