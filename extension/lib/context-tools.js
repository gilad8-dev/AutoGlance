/**
 * Context tool registry.
 *
 * Each tool gathers a specific kind of browser context for LLM2. Tool names
 * are the planner's exact vocabulary - the planner returns a list of these
 * names and `gatherTools` runs them and produces a normalized package.
 *
 * MVP active tools:
 *   - none                    no extra context
 *   - viewport_dom            sanitized visible-text extraction, capped
 *   - viewport_screenshot     compressed JPEG of the visible tab
 *
 * Future tools (registered later in Stage B):
 *   - full_page_dom, element_crop, focused_element_context
 *
 * Privacy: every tool that needs page access checks the privacyStatus passed
 * in the gather context. The orchestrator gates first, but tools defend in
 * depth - they refuse to run on a blocked page even if asked.
 *
 * Sanitization: the in-page DOM extractor never reads form-field values,
 * never touches password / autocomplete-sensitive inputs, never includes
 * hidden inputs, and never crosses into <script>/<style>/<noscript>/<iframe>
 * subtrees. Output is plain visible text with light markdown-ish heading
 * prefixes; capped at 6 KB.
 */

import { compressScreenshot } from './context-builder.js';
import { estimateTextTokens, estimateImageTokens } from './cost-estimator.js';

export const TOOL_NAMES = ['none', 'viewport_dom', 'viewport_screenshot'];

/** Cap on sanitized DOM output, in chars. Mirrors the planner's mental model. */
export const VIEWPORT_DOM_SIZE_CAP = 6000;

// ── In-page sanitizer ──────────────────────────────────────────────────────

/**
 * Self-contained extractor injected via chrome.scripting.executeScript.
 * Walks visible text nodes, applies privacy/PII filters, and returns up to
 * VIEWPORT_DOM_SIZE_CAP chars of normalized text. No closures, no imports.
 */
export function extractViewportDomInPage() {
  const SIZE_CAP = 6000;

  // Autocomplete tokens that signal sensitive fields. We never read these.
  const SENSITIVE_AUTOCOMPLETE = /^(?:cc-|current-password|new-password|one-time-code|webauthn)/i;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE']);
  const BLOCK_TAGS = new Set([
    'DIV', 'P', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'SECTION', 'ARTICLE',
    'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'TR', 'TD', 'TH',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY',
  ]);
  const BLOCK_SELECTOR = Array.from(BLOCK_TAGS).join(',');

  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;

  function intersectsViewport(rect) {
    return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  }

  function isVisible(el) {
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return false;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (parseFloat(cs.opacity) === 0) return false;
    } catch { return false; }
    return true;
  }

  function isInsideSensitiveInput(el) {
    // Climb to the nearest form-field ancestor; refuse to read anything inside.
    const field = el.closest && el.closest('input, textarea, select');
    if (!field) return false;
    const tag = field.tagName;
    if (tag === 'INPUT') {
      const type = (field.type || 'text').toLowerCase();
      if (type === 'password' || type === 'hidden') return true;
      if (type === 'email' || type === 'tel') return true;  // err on the side of privacy
    }
    const ac = (field.getAttribute('autocomplete') || '').toLowerCase();
    if (SENSITIVE_AUTOCOMPLETE.test(ac)) return true;
    // Conservative: never read text inside any input-like element. Their text
    // content is rarely the user's intent and often contains PII via JS-bound
    // values rendered as text nodes (e.g. Stripe-like card displays).
    return true;
  }

  function shouldSkipParent(parent) {
    if (!parent) return true;
    if (SKIP_TAGS.has(parent.tagName)) return true;
    if (parent.closest && parent.closest(Array.from(SKIP_TAGS).join(','))) return true;
    if (isInsideSensitiveInput(parent)) return true;
    if (!isVisible(parent)) return true;
    return false;
  }

  function headingPrefix(tag) {
    if (tag === 'H1') return '# ';
    if (tag === 'H2') return '## ';
    if (tag === 'H3') return '### ';
    if (tag === 'H4') return '#### ';
    if (tag === 'H5') return '##### ';
    if (tag === 'H6') return '###### ';
    return '';
  }

  let out = '';
  let truncated = false;
  let lastBlock = null;

  const root = document.body || document.documentElement;
  if (root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = node.nodeValue;
        if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (shouldSkipParent(parent)) return NodeFilter.FILTER_REJECT;
        let rect;
        try { rect = parent.getBoundingClientRect(); } catch { return NodeFilter.FILTER_REJECT; }
        if (!intersectsViewport(rect)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;

      const blockAncestor = parent.closest ? parent.closest(BLOCK_SELECTOR) : null;
      let segment = '';

      if (blockAncestor && blockAncestor !== lastBlock) {
        if (out.length > 0) segment += '\n';
        segment += headingPrefix(blockAncestor.tagName);
        lastBlock = blockAncestor;
      } else if (out.length > 0 && !out.endsWith(' ') && !out.endsWith('\n')) {
        segment += ' ';
      }
      segment += text;

      if (out.length + segment.length > SIZE_CAP) {
        const remaining = SIZE_CAP - out.length;
        if (remaining > 0) out += segment.slice(0, remaining);
        truncated = true;
        break;
      }
      out += segment;
    }
  }

  return {
    content: out.trim(),
    truncated,
    sizeBytes: out.length,
    capBytes: SIZE_CAP,
    viewportW: vw,
    viewportH: vh,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Read an image's natural dimensions from a data URL. Side-panel context only. */
function readImageDims(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

function emptyPiece(type, extra = {}) {
  return {
    type,
    textBlocks: [],
    images: [],
    sizeBytes: 0,
    estTokens: 0,
    ...extra,
  };
}

function ensurePagePermission(privacyStatus) {
  if (!privacyStatus || privacyStatus.state !== 'enabled') {
    const reason = privacyStatus?.category
      ? `Glance off – ${privacyStatus.category}`
      : 'Glance off this turn';
    throw new Error(reason);
  }
}

// ── Tool registry ──────────────────────────────────────────────────────────

/**
 * Each entry:
 *   name        Identifier matching the planner's vocabulary.
 *   available   (manifest) => boolean. Cheap availability check from manifest.
 *               Used by the orchestrator to filter the cost menu.
 *   gather      async (context) => piece. Throws on failure; the orchestrator
 *               catches and records the error in the package.
 */
export const TOOLS = {
  none: {
    name: 'none',
    available: () => true,
    gather: async () => emptyPiece('none'),
  },

  viewport_dom: {
    name: 'viewport_dom',
    // domReliable is set by the manifest extractor (page-manifest.js). It's
    // false on canvas-dominant pages, near-empty pages, PDFs, and similar
    // contexts where text extraction won't help.
    available: (manifest) => manifest?.domReliable !== false,
    gather: async ({ manifest, privacyStatus, llm2Model }) => {
      ensurePagePermission(privacyStatus);

      // Execute directly from the side panel — no service worker round-trip
      // (avoids the MV3 SW lifetime issue where the port closes mid-flight).
      const tabId = manifest?.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (!tabId) throw new Error('no active tab found for viewport_dom');

      let results;
      try {
        results = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractViewportDomInPage,
        });
      } catch (err) {
        throw new Error(`viewport_dom extraction failed: ${err.message}`);
      }

      const dom = results?.[0]?.result;
      if (!dom) throw new Error('viewport_dom extraction returned no result');

      const { content, truncated, sizeBytes } = dom;
      const estTokens = estimateTextTokens(content.length);

      return {
        type: 'viewport_dom',
        textBlocks: [{
          name: 'viewport_dom',
          content,
          sizeBytes,
          estTokens,
          truncated,
        }],
        images: [],
        sizeBytes,
        estTokens,
      };
    },
  },

  viewport_screenshot: {
    name: 'viewport_screenshot',
    available: () => true,
    gather: async ({ settings, privacyStatus, llm2Model }) => {
      ensurePagePermission(privacyStatus);

      const cap = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
      if (!cap?.success) {
        throw new Error(cap?.error || 'viewport_screenshot capture failed');
      }
      const base64 = await compressScreenshot(
        cap.dataUrl,
        settings?.maxImageWidth     ?? 1280,
        (settings?.screenshotQuality ?? 70) / 100,
      );
      const dims = await readImageDims(`data:image/jpeg;base64,${base64}`);
      // base64 expands raw bytes by ~4/3; reverse that for actual payload size.
      const sizeBytes = Math.ceil((base64.length * 3) / 4);
      const estTokens = estimateImageTokens(llm2Model, dims.width, dims.height);

      return {
        type: 'viewport_screenshot',
        textBlocks: [],
        images: [{
          name: 'viewport_screenshot',
          base64,
          mediaType: 'image/jpeg',
          width:  dims.width,
          height: dims.height,
          estTokens,
        }],
        sizeBytes,
        estTokens,
      };
    },
  },
};

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run a list of tools and return one normalized package. Unknown or
 * unavailable tool names are recorded under `errors` rather than thrown.
 *
 * @param {string[]} types  Subset of TOOL_NAMES requested by the planner.
 * @param {object}   ctx    { manifest, settings, privacyStatus, llm2Model }
 * @returns {Promise<{
 *   types: string[],
 *   textBlocks: Array<{name,content,sizeBytes,estTokens,truncated?}>,
 *   images:     Array<{name,base64,mediaType,width,height,estTokens}>,
 *   totalSizeBytes: number,
 *   totalEstTokens: number,
 *   summary: string,
 *   errors: Record<string,string>
 * }>}
 */
export async function gatherTools(types, ctx = {}) {
  const errors = {};
  const pieces = [];
  const seen = new Set();

  for (const type of types ?? []) {
    if (seen.has(type)) continue;        // dedupe in case planner repeats
    seen.add(type);

    const tool = TOOLS[type];
    if (!tool) {
      errors[type] = 'unknown tool';
      continue;
    }
    if (tool.available && !tool.available(ctx.manifest)) {
      errors[type] = 'unavailable for this page';
      continue;
    }
    try {
      const piece = await tool.gather(ctx);
      if (piece) pieces.push(piece);
    } catch (err) {
      errors[type] = err?.message || 'gather failed';
    }
  }

  return combinePackage(pieces, errors);
}

/** Empty package used when the planner picks `none` or all tools fail. */
export function emptyPackage() {
  return combinePackage([], {});
}

function combinePackage(pieces, errors) {
  const types        = pieces.map((p) => p.type);
  const textBlocks   = pieces.flatMap((p) => p.textBlocks ?? []);
  const images       = pieces.flatMap((p) => p.images     ?? []);
  const totalSizeBytes = pieces.reduce((s, p) => s + (p.sizeBytes ?? 0), 0);
  const totalEstTokens = pieces.reduce((s, p) => s + (p.estTokens ?? 0), 0);

  const parts = [];
  for (const p of pieces) {
    if (p.type === 'none') continue;
    if (p.type === 'viewport_dom') {
      const tb = p.textBlocks?.[0];
      const kb = tb ? (tb.sizeBytes / 1024).toFixed(1) : '0.0';
      parts.push(`viewport_dom ${kb}KB${tb?.truncated ? ' (truncated)' : ''}`);
    } else if (p.type === 'viewport_screenshot') {
      const img = p.images?.[0];
      parts.push(img ? `screenshot ${img.width}×${img.height}` : 'screenshot');
    } else {
      parts.push(p.type);
    }
  }
  const summary = parts.length ? parts.join(' + ') : 'none';

  return { types, textBlocks, images, totalSizeBytes, totalEstTokens, summary, errors };
}
