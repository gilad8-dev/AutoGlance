/**
 * Page manifest - facts-only description of the active tab.
 *
 * Used by the planner (LLM1) to decide what context to gather. The manifest
 * never contains raw page text or attribute values - only counts, sizes,
 * presence flags, and short cheap hashes. This keeps the planner's input
 * free of page content (and free of prompt-injection vectors from page text).
 *
 * Layered:
 *   - extractManifestInPage()   runs inside the page (chrome.scripting.executeScript).
 *                               Self-contained: no imports, no closures.
 *   - buildManifest()           runs in side-panel context. Sends a message to
 *                               the service worker, augments the result with
 *                               side-effect-free derivations (sensitive-keyword hit).
 */

import { detectSensitivePattern } from './privacy-rules.js';

/**
 * In-page extractor. Serialized and shipped to the page by the service worker.
 * Must be entirely self-contained: any helpers it needs are nested inside it,
 * and it cannot reference any closure variables.
 */
export function extractManifestInPage() {
  // djb2 - cheap deterministic 32-bit hash, base36 string.
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  function intersectsViewport(rect, vw, vh) {
    return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  }

  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
  const docHeight = Math.max(
    document.documentElement.scrollHeight || 0,
    (document.body && document.body.scrollHeight) || 0
  );
  const scrollMaxY = Math.max(0, docHeight - vh);

  // Visible text - walk text nodes, sum chars whose parent rect intersects the
  // viewport. Bounded sample (4 KB) is hashed for change detection. We never
  // ship the sample itself; only the hash + the count leave the page here.
  let visibleTextChars = 0;
  let visibleTextSample = '';
  const SAMPLE_CAP = 4096;
  const root = document.body || document.documentElement;
  if (root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const t = n.nodeValue;
        if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      let rect;
      try { rect = parent.getBoundingClientRect(); } catch { continue; }
      if (!intersectsViewport(rect, vw, vh)) continue;
      const text = node.nodeValue;
      visibleTextChars += text.length;
      if (visibleTextSample.length < SAMPLE_CAP) {
        visibleTextSample += text.slice(0, SAMPLE_CAP - visibleTextSample.length);
      }
    }
  }

  // Full text length is an estimate - textContent.length is cheap (no layout)
  // but slightly overcounts vs innerText. Good enough for routing decisions.
  const fullTextLengthEstimate = root ? (root.textContent || '').length : 0;

  // Visible images - count, large-image flag, and src list for the media hash.
  let visibleImageCount = 0;
  let hasLargeVisibleImage = false;
  const mediaSrcs = [];
  for (const img of document.querySelectorAll('img')) {
    let rect;
    try { rect = img.getBoundingClientRect(); } catch { continue; }
    if (!intersectsViewport(rect, vw, vh)) continue;
    visibleImageCount++;
    if (rect.width >= 200 && rect.height >= 200) hasLargeVisibleImage = true;
    const src = img.currentSrc || img.src;
    if (src) mediaSrcs.push(src);
  }

  // Element-type presence flags
  const hasCanvas    = !!document.querySelector('canvas');
  const hasSvg       = !!document.querySelector('svg');
  const hasTable     = !!document.querySelector('table');
  const hasFormInput = !!document.querySelector('input, textarea, select, [contenteditable="true"]');

  // Focused element - skip body/html, which are default activeElement when nothing is focused.
  const ae = document.activeElement;
  const isMeaningfulFocus = !!(ae && ae !== document.body && ae !== document.documentElement);
  const hasFocusedElement = isMeaningfulFocus;
  let focusedElementType = null;
  if (isMeaningfulFocus) {
    const tag = (ae.tagName || '').toLowerCase();
    if (tag === 'input') {
      focusedElementType = `input:${(ae.type || 'text').toLowerCase()}`;
    } else if (ae.isContentEditable) {
      focusedElementType = `${tag}:contenteditable`;
    } else {
      focusedElementType = tag;
    }
  }

  // Cross-origin iframes - flagged so the planner knows DOM tools may miss them.
  let hasCrossOriginIframes = false;
  for (const f of document.querySelectorAll('iframe')) {
    try {
      if (!f.src) continue;
      const u = new URL(f.src, location.href);
      if (u.origin && u.origin !== location.origin) {
        hasCrossOriginIframes = true;
        break;
      }
    } catch { /* ignore unparseable src */ }
  }

  // domReliable: false if the page is mostly canvas (whiteboard, map, game) or
  // has too little text to extract meaningfully. The planner uses this to skip
  // DOM tools in favour of screenshot/crop.
  let canvasDominantViewport = false;
  if (hasCanvas) {
    const viewportArea = vw * vh;
    for (const c of document.querySelectorAll('canvas')) {
      let r;
      try { r = c.getBoundingClientRect(); } catch { continue; }
      if (!intersectsViewport(r, vw, vh)) continue;
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (viewportArea > 0 && w * h > viewportArea * 0.5) {
        canvasDominantViewport = true;
        break;
      }
    }
  }
  const domReliable = visibleTextChars > 200 && !canvasDominantViewport;

  return {
    url: location.href,
    title: document.title || '',
    timestamp: Date.now(),
    viewportW: vw,
    viewportH: vh,
    scrollY,
    scrollMaxY,
    visibleTextLength: visibleTextChars,
    fullTextLengthEstimate,
    visibleImageCount,
    hasLargeVisibleImage,
    hasCanvas,
    hasSvg,
    hasTable,
    hasFormInput,
    hasFocusedElement,
    focusedElementType,
    domReliable,
    hasCrossOriginIframes,
    visibleDomHash: hash(visibleTextSample),
    mediaHash:      hash(mediaSrcs.join('|')),
  };
}

/**
 * Build a manifest for the active tab. Returns null on extraction failure
 * (chrome:// pages, file picker dialogs, sandboxed PDF viewers, etc.).
 *
 * Augments the in-page result with tabId and a sensitive-keyword flag derived
 * from URL + title (cheap regex match using existing privacy-rules helper).
 */
export async function buildManifest() {
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'GET_PAGE_MANIFEST' });
  } catch {
    return null; // service worker restarting or no listener
  }
  if (!result?.success || !result.manifest) return null;

  const m = result.manifest;
  m.tabId = result.tabId ?? null;
  m.sensitiveKeywordsHit = detectSensitivePattern(m.url || '', m.title || '');
  return m;
}
