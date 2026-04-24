/**
 * AutoGlance Side Panel - main application module.
 *
 * Flow for each user message:
 *  1. Get current tab info from service worker
 *  2. Check privacy rules (domain blocklist + screenshot toggle)
 *  3. Optionally capture & compress screenshot via service worker + canvas
 *  4. Build user text (with page metadata) via context-builder
 *  5. Stream response via ai-client (dispatches to active provider)
 *  6. Render streamed text with light Markdown formatting
 */

import { getSettings, saveSettings, onSettingsChanged, getActiveApiKey, getActiveModel, PROVIDERS, getModelsByProvider, getModelById } from '../lib/storage.js';
import { getPrivacyStatus } from '../lib/privacy-rules.js';
import { compressScreenshot, buildUserText, SYSTEM_PROMPT, prepareHistory } from '../lib/context-builder.js';
import { streamMessage } from '../lib/ai-client.js';

// ── State ─────────────────────────────────────────────────────────────────

let settings = null;
let currentTab = null;
let isStreaming = false;
let abortController = null;

/** Each entry: { role: 'user'|'assistant', textContent: string } */
let conversationHistory = [];

// ── DOM Refs ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const messagesEl       = $('messages');
const inputEl          = $('message-input');
const sendBtn          = $('send-btn');
const clearBtn         = $('clear-btn');
const settingsBtn      = $('settings-btn');
const screenshotToggle = $('screenshot-toggle');
const inputArea        = document.querySelector('.input-area');
const privacyBar       = $('privacy-bar');
const privacyLabel     = $('privacy-label');
const apiKeyWarning    = $('api-key-warning');
const contextBadge     = $('context-badge');
const providerBadge    = $('provider-badge');
const providerToggle   = $('provider-toggle');
const modelSelect      = $('model-select');

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  settings = await getSettings();
  await refreshTabInfo();
  bindEvents();
  updateProviderBadge();
  renderControlsBar();
  updatePrivacyUI();
  updateScreenshotToggleUI();
  checkApiKeyWarning();

  onSettingsChanged((changed) => {
    Object.assign(settings, changed);
    updateProviderBadge();
    renderControlsBar();
    updatePrivacyUI();
    updateScreenshotToggleUI();
    checkApiKeyWarning();
  });
}

// ── Events ────────────────────────────────────────────────────────────────

function bindEvents() {
  sendBtn.addEventListener('click', handleSend);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  inputEl.addEventListener('input', () => {
    autoResizeInput();
    sendBtn.disabled = inputEl.value.trim() === '' || isStreaming;
  });

  clearBtn.addEventListener('click', clearConversation);

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  });

  screenshotToggle.addEventListener('click', toggleScreenshot);

  // Provider chips - click switches provider, or opens Settings if no key.
  providerToggle.querySelectorAll('.provider-chip').forEach((chip) => {
    chip.addEventListener('click', () => handleProviderClick(chip.dataset.provider));
  });

  // Model dropdown - save the new choice for the active provider.
  modelSelect.addEventListener('change', handleModelChange);

  $('warning-settings-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  });

  document.querySelectorAll('.suggestion-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      inputEl.value = chip.dataset.text;
      autoResizeInput();
      sendBtn.disabled = false;
      inputEl.focus();
      handleSend();
    });
  });

  window.addEventListener('focus', refreshTabInfo);

  // Delegated copy button handler for code blocks
  document.getElementById('messages').addEventListener('click', (e) => {
    const btn = e.target.closest('.code-copy-btn');
    if (!btn) return;
    const code = codeStore.get(parseInt(btn.dataset.codeId, 10)) ?? '';
    navigator.clipboard.writeText(code).then(() => {
      const span = btn.querySelector('span');
      span.textContent = 'Copied!';
      btn.classList.add('code-copy-btn--copied');
      setTimeout(() => {
        span.textContent = 'Copy';
        btn.classList.remove('code-copy-btn--copied');
      }, 2000);
    });
  });
}

// ── Core Send Handler ─────────────────────────────────────────────────────

async function handleSend() {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;

  const apiKey = getActiveApiKey(settings);
  if (!apiKey) {
    apiKeyWarning.classList.remove('hidden');
    return;
  }

  inputEl.value = '';
  autoResizeInput();
  sendBtn.disabled = true;

  setStreaming(true);

  // First send = welcome hero still present. Wrap the DOM swap in a view
  // transition so the hero collapses into the new user bubble while pills
  // scatter on stagger (see .welcome + ::view-transition-* CSS). The user
  // bubble inherits the shared "welcome-hero" name for the duration of the
  // transition, then the inline name is cleared so subsequent bubbles flow
  // normally. Reduced-motion and unsupported browsers fall through.
  const welcome = messagesEl.querySelector('.welcome');
  const canMorph = !!welcome
    && typeof document.startViewTransition === 'function'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let typingEl;
  if (canMorph) {
    let morphedRow = null;
    const transition = document.startViewTransition(() => {
      welcome.remove();
      const { rowEl } = appendUserBubble(text);
      // Skip the default fade-up so the view transition owns the entry motion.
      rowEl.style.animation = 'none';
      rowEl.style.viewTransitionName = 'welcome-hero';
      morphedRow = rowEl;
      typingEl = appendTypingIndicator();
    });
    // Wait for the callback to run so typingEl is set before we proceed.
    await transition.updateCallbackDone;
    transition.finished.finally(() => {
      if (morphedRow) {
        morphedRow.style.viewTransitionName = '';
        morphedRow.style.animation = '';
      }
    });
  } else {
    if (welcome) welcome.remove();
    appendUserBubble(text);
    typingEl = appendTypingIndicator();
  }

  try {
    await refreshTabInfo();

    const privacyStatus = computePrivacyStatus();
    updatePrivacyUI(privacyStatus);

    // Privacy gate: only share page data when the user hasn't turned the
    // screenshot off and the domain isn't blocklisted. Screenshot + page
    // metadata travel together - toggling off means nothing leaves the tab.
    let screenshot = null;
    let pageContext = null;
    if (privacyStatus.state === 'enabled') {
      screenshot = await captureScreenshot();
      const ctxResult = await chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTEXT' });
      if (ctxResult?.success) pageContext = ctxResult.context;
    }

    // Build the text portion of this turn (includes page metadata when allowed)
    const userText = buildUserText(text, pageContext, !!screenshot);

    // Store user turn
    conversationHistory.push({ role: 'user', textContent: userText });

    typingEl.remove();
    const { bubbleEl } = appendAssistantBubble('');
    bubbleEl.classList.add('loading-cursor');

    abortController = new AbortController();
    let fullText = '';

    await streamMessage({
      provider:     settings.provider,
      apiKey,
      model:        getActiveModel(settings),
      systemPrompt: SYSTEM_PROMPT,
      history:      prepareHistory(conversationHistory.slice(0, -1)),
      userText,
      screenshot,
      signal: abortController.signal,
      onChunk: (chunk) => {
        fullText += chunk;
        bubbleEl.innerHTML = renderMarkdown(sealOpenFences(fullText));
        bubbleEl.classList.add('loading-cursor');
        scrollToBottom();
      },
    });

    bubbleEl.classList.remove('loading-cursor');

    conversationHistory.push({ role: 'assistant', textContent: fullText });

    // Cap history at 40 entries (~20 pairs)
    if (conversationHistory.length > 40) {
      conversationHistory = conversationHistory.slice(-38);
    }

  } catch (err) {
    typingEl.remove();
    // Only suppress AbortErrors that the user explicitly triggered via the stop button.
    // Timeout aborts fire on the internal controller, leaving abortController.signal intact.
    const isUserStop = err.name === 'AbortError' && abortController?.signal.aborted;
    if (!isUserStop) {
      appendErrorBubble(err.message || 'Something went wrong. Please try again.');
    }
  } finally {
    setStreaming(false);
    abortController = null;
    scrollToBottom();
  }
}

// ── Screenshot ────────────────────────────────────────────────────────────

async function captureScreenshot() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
    if (!result?.success) return null;
    return await compressScreenshot(result.dataUrl, settings.maxImageWidth, settings.screenshotQuality / 100);
  } catch {
    return null; // Non-fatal - degrade gracefully to text-only
  }
}

// ── Privacy ───────────────────────────────────────────────────────────────

function computePrivacyStatus() {
  if (!settings.screenshotEnabled) return { state: 'disabled' };
  if (!currentTab?.url) return { state: 'disabled' };
  const status = getPrivacyStatus(currentTab.url, settings.blockedDomains);
  return status.blocked ? { state: 'blocked', category: status.category } : { state: 'enabled' };
}

async function refreshTabInfo() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_TAB_INFO' });
    if (result?.success && result.tab) currentTab = result.tab;
    updatePrivacyUI();
  } catch { /* service worker restarting - ignore */ }
}

function updatePrivacyUI(privacyOverride) {
  const { state, category } = privacyOverride ?? computePrivacyStatus();

  privacyBar.className = `privacy-bar privacy-${state}`;

  let blockedLabel = 'Screenshot disabled';
  if (category === 'internal') blockedLabel = 'Browser page - screenshot unavailable';
  else if (category === 'blocklist') blockedLabel = 'Blocked domain - screenshot disabled';

  const labels = {
    enabled:  'Screenshot enabled',
    blocked:  blockedLabel,
    disabled: 'Screenshot off',
  };
  privacyLabel.textContent = labels[state] ?? '';

  const badgeClasses = { enabled: 'context-badge--active', blocked: 'context-badge--blocked', disabled: 'context-badge--disabled' };
  contextBadge.className = `context-badge ${badgeClasses[state] ?? ''}`;

  const badgeTexts = { enabled: ' With screenshot', blocked: ' Private (protected)', disabled: ' Private' };
  contextBadge.lastChild.textContent = badgeTexts[state] ?? '';

  inputArea.classList.toggle('mode-enabled',  state === 'enabled');
  inputArea.classList.toggle('mode-blocked',  state === 'blocked');
  inputArea.classList.toggle('mode-disabled', state === 'disabled');
}

async function toggleScreenshot() {
  settings.screenshotEnabled = !settings.screenshotEnabled;
  await saveSettings({ screenshotEnabled: settings.screenshotEnabled });
  updateScreenshotToggleUI();
  updatePrivacyUI();
}

function updateScreenshotToggleUI() {
  screenshotToggle.classList.toggle('active', settings.screenshotEnabled);
  screenshotToggle.classList.toggle('inactive', !settings.screenshotEnabled);
  screenshotToggle.setAttribute('aria-pressed', String(settings.screenshotEnabled));
  screenshotToggle.title = settings.screenshotEnabled ? 'Screenshot: ON - click to disable' : 'Screenshot: OFF - click to enable';
}

// ── Provider Badge ────────────────────────────────────────────────────────

function updateProviderBadge() {
  const provider = settings.provider ?? 'anthropic';
  providerBadge.textContent = PROVIDERS[provider]?.shortLabel ?? provider;
  providerBadge.className = `provider-badge provider-badge--${provider}`;
}

// ── Controls Bar (provider + model) ───────────────────────────────────────

/**
 * Paint the provider chips and the model dropdown to match current settings.
 * A chip is marked `.no-key` (gray) when the user has no API key for that
 * provider - the chip is still clickable but clicking opens Settings.
 */
function renderControlsBar() {
  const activeProvider = settings.provider ?? 'anthropic';

  providerToggle.querySelectorAll('.provider-chip').forEach((chip) => {
    const provider = chip.dataset.provider;
    const hasKey   = !!settings[`${provider}ApiKey`];
    const isActive = provider === activeProvider;

    chip.classList.toggle('active',  isActive);
    chip.classList.toggle('no-key', !hasKey);
    chip.setAttribute('aria-checked', isActive ? 'true' : 'false');
    chip.title = hasKey
      ? `Use ${PROVIDERS[provider]?.label ?? provider}`
      : `No ${PROVIDERS[provider]?.label ?? provider} API key. Click to open Settings.`;
  });

  populateModelSelect(activeProvider);
}

function populateModelSelect(provider) {
  const stored = settings[`${provider}Model`] ?? '';
  const known  = getModelsByProvider(provider);

  modelSelect.innerHTML = '';
  for (const m of known) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.displayName;
    modelSelect.appendChild(opt);
  }

  // Preserve an unknown-but-saved id so switching into this provider never
  // silently rewrites the user's choice to a different model.
  if (stored && !getModelById(stored)) {
    const opt = document.createElement('option');
    opt.value = stored;
    opt.textContent = `${stored} (saved)`;
    modelSelect.appendChild(opt);
  }

  if (stored) modelSelect.value = stored;
}

async function handleProviderClick(provider) {
  if (!provider || provider === settings.provider) return;

  const hasKey = !!settings[`${provider}ApiKey`];
  if (!hasKey) {
    // No key for this provider - route the user to Settings rather than
    // switching into a provider that can't make requests.
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
    return;
  }

  settings.provider = provider;
  await saveSettings({ provider });
  // onSettingsChanged will re-render; no explicit call needed, but render now
  // for immediate feedback in case the storage event is delayed.
  renderControlsBar();
  updateProviderBadge();
  checkApiKeyWarning();
}

async function handleModelChange() {
  const provider = settings.provider ?? 'anthropic';
  const newModel = modelSelect.value;
  if (!newModel) return;

  settings[`${provider}Model`] = newModel;
  await saveSettings({ [`${provider}Model`]: newModel });
}

function checkApiKeyWarning() {
  const hasKey = !!getActiveApiKey(settings);
  apiKeyWarning.classList.toggle('hidden', hasKey);
  if (!hasKey) {
    const provider = settings.provider ?? 'anthropic';
    const providerLabel = PROVIDERS[provider]?.label ?? provider;
    const warningText = apiKeyWarning.querySelector('.warning-text p');
    if (warningText) warningText.textContent = `Add a ${providerLabel} API key in Settings to start chatting.`;
  }
}

// ── Conversation UI ───────────────────────────────────────────────────────

function appendUserBubble(text) {
  const row = document.createElement('div');
  row.className = 'message-row message-row--user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble bubble--user';
  bubble.dir = 'auto';
  bubble.textContent = text;
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollToBottom();
  return { rowEl: row, bubbleEl: bubble };
}

function appendAssistantBubble(text) {
  const row = document.createElement('div');
  row.className = 'message-row message-row--assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble bubble--assistant';
  bubble.dir = 'auto';
  if (text) bubble.innerHTML = renderMarkdown(text);
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollToBottom();
  return { rowEl: row, bubbleEl: bubble };
}

function appendErrorBubble(message) {
  const row = document.createElement('div');
  row.className = 'message-row message-row--assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble bubble--error';
  bubble.textContent = `⚠ ${message}`;
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollToBottom();
}

function appendTypingIndicator() {
  const row = document.createElement('div');
  row.className = 'message-row message-row--assistant';
  row.innerHTML = `
    <div class="typing-indicator">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>`;
  messagesEl.appendChild(row);
  scrollToBottom();
  return row;
}

function clearConversation() {
  conversationHistory = [];
  messagesEl.innerHTML = `
    <div class="welcome">
      <h1 class="welcome-greeting">Hello. <em>What are you looking at?</em></h1>
      <p>I'm AutoGlance, a browser companion with a view. Ask me about anything on this page and I'll see what you see.</p>
      <div class="welcome-suggestions">
        <button class="suggestion-chip" data-text="What am I looking at?">What am I looking at?</button>
        <button class="suggestion-chip" data-text="Summarize this page for me.">Summarize this page</button>
        <button class="suggestion-chip" data-text="Where do I click to sign up?">Where do I click to sign up?</button>
        <button class="suggestion-chip" data-text="Explain the chart on screen.">Explain the chart on screen</button>
      </div>
    </div>`;
  document.querySelectorAll('.suggestion-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      inputEl.value = chip.dataset.text;
      autoResizeInput();
      sendBtn.disabled = false;
      handleSend();
    });
  });
}

// ── Code Store ────────────────────────────────────────────────────────────
// Stores raw code strings by ID so the copy button never has to encode/decode them.
const codeStore = new Map();
let codeStoreNextId = 0;

// ── Markdown Renderer ─────────────────────────────────────────────────────

// Configure marked once at module load.
// window.marked is set by the classic <script> tag that loads before this module.
(function configureMarked() {
  const marked = window.marked;
  if (!marked) return;

  // Pass a plain renderer object - `this` inside each method is the live
  // renderer instance (with `this.parser` properly wired by marked internals).
  marked.use({
    gfm: true,
    breaks: true, // single newline → <br> - natural for chat
    renderer: {
      code({ text, lang }) {
        const safeLang = lang ? lang.replace(/[^a-zA-Z0-9_+\-./]/g, '') : '';
        const hljs = window.hljs;
        let highlighted;
        if (hljs) {
          try {
            highlighted = safeLang && hljs.getLanguage(safeLang)
              ? hljs.highlight(text, { language: safeLang, ignoreIllegals: true }).value
              : hljs.highlightAuto(text).value;
          } catch {
            highlighted = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          }
        } else {
          highlighted = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        const codeId = codeStoreNextId++;
        codeStore.set(codeId, text);
        const label = safeLang ? `<span class="code-lang">${safeLang}</span>` : '';
        const copyBtn = `<button class="code-copy-btn" title="Copy code" data-code-id="${codeId}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>Copy</span>
        </button>`;
        return `<div class="code-block"><div class="code-header">${label}${copyBtn}</div><pre><code class="hljs">${highlighted}</code></pre></div>`;
      },

      codespan({ text }) {
        return `<code class="inline-code">${text}</code>`;
      },

      blockquote({ tokens }) {
        return `<blockquote class="md-blockquote">${this.parser.parse(tokens)}</blockquote>`;
      },

      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const safeHref = /^https?:\/\//i.test(href ?? '') ? href : '#';
        const titleAttr = title ? ` title="${title}"` : '';
        return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
      },

      table(token) {
        let thead = '';
        for (const cell of token.header) {
          const align = cell.align ? ` style="text-align:${cell.align}"` : '';
          thead += `<th${align}>${this.parser.parseInline(cell.tokens)}</th>`;
        }
        let tbody = '';
        for (const row of token.rows) {
          let cells = '';
          for (const cell of row) {
            const align = cell.align ? ` style="text-align:${cell.align}"` : '';
            cells += `<td${align}>${this.parser.parseInline(cell.tokens)}</td>`;
          }
          tbody += `<tr>${cells}</tr>`;
        }
        return `<div class="table-wrap"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
      },
    },
  });
})();

// Close any unclosed code fence so marked doesn't nest subsequent blocks inside it.
function sealOpenFences(text) {
  const fences = text.match(/^`{3,}/gm) || [];
  return fences.length % 2 !== 0 ? text + '\n```' : text;
}

function renderMarkdown(text) {
  if (!window.marked) {
    return `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`;
  }
  if (!window.katex) {
    return window.marked.parse(text);
  }
  // extractAndRenderMath returns modified markdown (with NUL sentinels) + a slot restore fn
  const { markdown, restoreSlots } = extractAndRenderMath(text);
  let html = window.marked.parse(markdown);
  return restoreSlots(html);
}

/**
 * Pre-processes math expressions before marked sees the text.
 * Replaces $$ … $$ and $ … $ with rendered MathML placeholders,
 * then restores them after marked runs so marked never mangles the LaTeX.
 * Also catches bare \begin{env}…\end{env} blocks without delimiters.
 */
// Returns { markdown, restoreSlots } - markdown has NUL sentinels where math was;
// restoreSlots(html) swaps them back with rendered MathML after marked.parse runs.
function extractAndRenderMath(text) {
  const katex = window.katex;
  const slots = [];
  const codeSlots = [];

  // Shield fenced code blocks and inline code FIRST so math regexes never
  // touch code content (e.g. template literals like ${var} look like LaTeX).
  let shielded = text
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, (match) => {
      codeSlots.push(match);
      return `\x01CODE${codeSlots.length - 1}\x01`;
    })
    .replace(/`[^`\n]+`/g, (match) => {
      codeSlots.push(match);
      return `\x01CODE${codeSlots.length - 1}\x01`;
    });

  function renderSlot(latex, display) {
    const id = slots.length;
    let html;
    try {
      html = katex.renderToString(latex.trim(), {
        output: 'mathml',
        displayMode: display,
        throwOnError: false,
        strict: false,
      });
    } catch {
      html = `<code class="inline-code">${latex.replace(/</g, '&lt;')}</code>`;
    }
    slots.push({ html, display });
    return `\x00MATH${id}\x00`;
  }

  // Order matters: most specific delimiters first so a longer form doesn't get
  // half-matched by a shorter one (e.g. $$x$$ must run before $...$).
  let markdown = shielded
    // Display: $$ ... $$
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, latex) => renderSlot(latex, true))
    // Display: \\[ ... \\] (double-escaped form, sometimes emitted when LaTeX comes through a JSON string)
    .replace(/\\\\\[([\s\S]+?)\\\\\]/g, (_, latex) => renderSlot(latex, true))
    // Inline: \\( ... \\) (double-escaped form)
    .replace(/\\\\\(([\s\S]+?)\\\\\)/g, (_, latex) => renderSlot(latex, false))
    // Display: \[ ... \]
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, latex) => renderSlot(latex, true))
    // Inline: \( ... \)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, latex) => renderSlot(latex, false))
    // Display: [$ ... $] and [$$ ... $$] (bracketed-dollar variants some models invent)
    .replace(/\[\s*\$\$?([\s\S]+?)\$\$?\s*\]/g, (_, latex) => renderSlot(latex, true))
    // Inline: ($ ... $) (paren-dollar variant, single-line only to avoid swallowing prose)
    .replace(/\(\s*\$([^\n$]+?)\$\s*\)/g, (_, latex) => renderSlot(latex, false))
    // Display: bracketed environments [ \begin{env}...\end{env} ] or ( ... )
    .replace(/[\[(]\s*\n?\s*(\\begin\{([a-zA-Z*]+)\}[\s\S]+?\\end\{\2\})\s*\n?\s*[\])]/g,
      (_, latex) => renderSlot(latex, true))
    // Display: bare \begin{env}...\end{env}
    .replace(/\\begin\{([a-zA-Z*]+)\}[\s\S]+?\\end\{\1\}/g,
      (match) => renderSlot(match, true))
    // Display: bare brackets [ … ] wrapping LaTeX with no $ delimiter (model dropped delimiters).
    // Heuristic: must contain at least one \cmd backslash-letter sequence, no nested brackets,
    // and not be immediately followed by ( - which would make it a Markdown link reference.
    .replace(/\[\s*([^\[\]]*?\\[a-zA-Z]+[^\[\]]*?)\s*\](?!\()/g,
      (_, latex) => renderSlot(latex, true))
    // Inline: bare parens ( … ) wrapping LaTeX with no $ delimiter
    .replace(/\(\s*([^()]*?\\[a-zA-Z]+[^()]*?)\s*\)/g,
      (_, latex) => renderSlot(latex, false))
    // Cleanup: unwrap leftover brackets/parens around an already-extracted math slot
    .replace(/[\[(]\s*(\x00MATH\d+\x00)\s*[\])]/g, (_, s) => s)
    // Display: multi-line $ ... $ (a $ followed by newline → treat as display block)
    .replace(/\$\s*\n([\s\S]+?)\n\s*\$/g, (_, latex) => renderSlot(latex, true))
    // Inline: $ ... $ (single line, no template-literal ${, no backticks)
    .replace(/\$(?!\{)([^\n$`]+?)\$/g, (_, latex) => renderSlot(latex, false));

  // Restore shielded code blocks - marked will process them normally
  markdown = markdown.replace(/\x01CODE(\d+)\x01/g, (_, i) => codeSlots[parseInt(i, 10)]);

  function restoreSlots(html) {
    return html.replace(/\x00MATH(\d+)\x00/g, (_, i) => {
      const { html: mathHtml, display } = slots[parseInt(i, 10)];
      return display
        ? `<div class="math-block">${mathHtml}</div>`
        : `<span class="math-inline">${mathHtml}</span>`;
    });
  }

  return { markdown, restoreSlots };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function autoResizeInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
}

function setStreaming(active) {
  isStreaming = active;
  sendBtn.disabled = active || !inputEl.value.trim();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

init().catch(console.error);
