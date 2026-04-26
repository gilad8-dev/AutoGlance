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
import { buildManifest } from '../lib/page-manifest.js';
import { createChangeSignalTracker } from '../lib/change-signals.js';
import { estimateOldFlowBaseline, buildCostMenu, estimateTextTokens, getPricing } from '../lib/cost-estimator.js';
import { startTurn as telemetryStart, update as telemetryUpdate, markEnd as telemetryMarkEnd, finalize as telemetryFinalize, costFromUsage } from '../lib/telemetry.js';
import { planContext, ALLOWED_CONTEXT_TYPES } from '../lib/planner.js';
import { gatherTools } from '../lib/context-tools.js';
import { askLLM2, degradeToProvideAnswer } from '../lib/llm2-protocol.js';

// ── State ─────────────────────────────────────────────────────────────────

let settings = null;
let currentTab = null;
let isStreaming = false;
let abortController = null;

/** Each entry: { role: 'user'|'assistant', textContent: string } */
let conversationHistory = [];

/**
 * Tracks the per-tab manifest history so we can produce change signals on
 * every send. Reset when the user clears the conversation. Lives only in
 * side-panel runtime memory; nothing persists.
 */
const signalTracker = createChangeSignalTracker();

// ── DOM Refs ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const messagesEl       = $('messages');
const inputEl          = $('message-input');
const sendBtn          = $('send-btn');
const clearBtn         = $('clear-btn');
const settingsBtn      = $('settings-btn');
const glanceToggle     = $('glance-toggle');
const inputArea        = document.querySelector('.input-area');
const privacyBar       = $('privacy-bar');
const privacyLabel     = $('privacy-label');
const apiKeyWarning    = $('api-key-warning');
const contextBadge     = $('context-badge');
const providerToggle   = $('provider-toggle');
const modelSelect      = $('model-select');

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  settings = await getSettings();
  await refreshTabInfo();
  bindEvents();
  renderControlsBar();
  updatePrivacyUI();
  updateGlanceToggleUI();
  checkApiKeyWarning();

  onSettingsChanged((changed) => {
    Object.assign(settings, changed);
    renderControlsBar();
    updatePrivacyUI();
    updateGlanceToggleUI();
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

  glanceToggle.addEventListener('click', toggleGlance);

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

  // Delegated handler for telemetry chip clicks - toggles its sibling drawer.
  document.getElementById('messages').addEventListener('click', (e) => {
    const chip = e.target.closest('.telemetry-chip');
    if (!chip) return;
    const drawer = chip.nextElementSibling;
    if (!drawer || !drawer.classList.contains('telemetry-drawer')) return;
    const wasHidden = drawer.classList.contains('hidden');
    drawer.classList.toggle('hidden');
    chip.setAttribute('aria-expanded', String(wasHidden));
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

    const llm2Model = getActiveModel(settings);

    // Decide which flow runs this turn. Three master gates apply in order:
    //   1. Glance master toggle (settings.glanceEnabled)
    //   2. Privacy gate (URL not blocklisted, not chrome://, etc.)
    //   3. Internal rollout flag for the planner-driven flow
    // useNewFlow requires all three. Otherwise we run the legacy single-shot
    // screenshot path, which is unchanged from prior behavior.
    const glanceCanInspect = settings.glanceEnabled && privacyStatus.state === 'enabled';
    const useNewFlow       = glanceCanInspect && !!settings._internalUsePlannerFlow;

    // Page inspection: build manifest whenever Glance can inspect (used by
    // both telemetry and the planner). Capture screenshot + page-context only
    // for the legacy flow - the planner picks its own tools.
    let screenshot  = null;
    let pageContext = null;
    let manifest    = null;
    if (glanceCanInspect) {
      manifest = await buildManifest();
      if (!useNewFlow) {
        screenshot = await captureScreenshot();
        const ctxResult = await chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTEXT' });
        if (ctxResult?.success) pageContext = ctxResult.context;
      }
    }

    // Build the text portion of this turn:
    //   Legacy flow → buildUserText prepends a [Browser Context] meta block.
    //   Planner flow → raw user text; askLLM2 wraps with <browser-context>.
    const userText = useNewFlow
      ? text
      : buildUserText(text, pageContext, !!screenshot);

    conversationHistory.push({ role: 'user', textContent: userText });

    // ── Telemetry setup (shared between flows) ────────────────────────────
    const historyChars = conversationHistory.reduce((s, m) => s + (m.textContent?.length ?? 0), 0);
    const changeSignals = manifest
      ? signalTracker.compute(manifest, conversationHistory.length > 1)
      : null;
    const oldFlowBaseline = manifest
      ? estimateOldFlowBaseline({
          manifest,
          llm2Model,
          userPromptText: userText,
          systemPromptChars: SYSTEM_PROMPT.length,
          historyChars,
        })
      : null;

    const telemetryEnabled = settings.showTelemetry && glanceCanInspect && manifest;
    const turnId = telemetryEnabled
      ? telemetryStart({
          flow:            useNewFlow ? 'planner' : 'legacy',
          llm2Provider:    settings.provider,
          llm2Model,
          plannerProvider: useNewFlow ? settings.plannerProvider : null,
          plannerModel:    useNewFlow ? settings.plannerModelId   : null,
          manifestSummary: summarizeManifest(manifest),
          changeSignals,
          oldFlowBaseline: oldFlowBaseline ? {
            estTokens:        oldFlowBaseline.estTokens,
            estCostUSD:       oldFlowBaseline.estCostUSD,
            estInputTokens:   oldFlowBaseline.estInputTokens,
            estInputCostUSD:  oldFlowBaseline.estInputCostUSD,
            estOutputTokens:  oldFlowBaseline.estOutputTokens,
            estOutputCostUSD: oldFlowBaseline.estOutputCostUSD,
            breakdown:        oldFlowBaseline.breakdown,
          } : null,
        })
      : null;

    typingEl.remove();
    const { rowEl: assistantRowEl, bubbleEl } = appendAssistantBubble('');
    bubbleEl.classList.add('loading-cursor');

    abortController = new AbortController();
    let fullText = '';

    if (useNewFlow) {
      // ── Planner flow ────────────────────────────────────────────────────
      const turnStartedAt = performance.now();
      let firstByteAt = null;

      // onChunk is shared across round 1 and round 2. If round 1 returns
      // request_more_context after streaming partial text (rare on Anthropic
      // when the model jumps straight to tool_use, but possible), the wrapper
      // resets fullText + the bubble before round 2 begins.
      const onChunk = (chunk) => {
        if (firstByteAt === null) firstByteAt = performance.now();
        fullText += chunk;
        bubbleEl.innerHTML = renderMarkdown(sealOpenFences(fullText));
        bubbleEl.classList.add('loading-cursor');
        scrollToBottom();
      };
      const resetBubble = () => {
        fullText = '';
        firstByteAt = null;
        bubbleEl.innerHTML = '';
      };

      const result = await runPlannerFlow({
        userPrompt:                text,
        manifest,
        changeSignals,
        conversationHasPriorTurns: conversationHistory.length > 1,
        history:                   prepareHistory(conversationHistory.slice(0, -1)),
        settings,
        privacyStatus,
        llm2Model,
        onChunk,
        resetBubble,
        signal: abortController.signal,
      });

      // Whatever finalAction.answer is, fullText already reflects what was
      // streamed. Make sure it equals the final answer (degrade path may have
      // injected text via onChunk, or the streaming path may have completed).
      bubbleEl.classList.remove('loading-cursor');
      const turnEndedAt = performance.now();

      conversationHistory.push({ role: 'assistant', textContent: fullText });

      if (turnId) {
        const planner       = result.planner;
        const finalPackage  = result.finalPackage;
        const finalAction   = result.finalAction;
        const llm2Pricing   = getPricing(llm2Model);

        // Estimate input cost for what we actually sent to LLM2 (text payload
        // tokens + package tokens). Output uses a 400-token assumption to
        // line up with the old-flow baseline assumption.
        const baseInputTokens = estimateTextTokens(SYSTEM_PROMPT.length + historyChars + (text?.length ?? 0));
        const llm2InputTokensEst = baseInputTokens + (finalPackage?.totalEstTokens ?? 0);
        const llm2OutputTokensEst = 400;
        const llm2EstCostUSD = llm2Pricing
          ? (llm2InputTokensEst  / 1_000_000) * llm2Pricing.inUSDPer1M
          + (llm2OutputTokensEst / 1_000_000) * llm2Pricing.outUSDPer1M
          : null;

        // Aggregate LLM2 actuals across round 1 + round 2 (when fallback ran).
        const llm2ActualInputTokens  = (result.llm2Round1?.action?.usage?.inputTokens  ?? 0)
                                     + (result.llm2Round2?.action?.usage?.inputTokens  ?? 0);
        const llm2ActualOutputTokens = (result.llm2Round1?.action?.usage?.outputTokens ?? 0)
                                     + (result.llm2Round2?.action?.usage?.outputTokens ?? 0);
        const llm2ActualCostUSD      = ((result.llm2Round1?.action?.costUSD ?? 0)
                                     +  (result.llm2Round2?.action?.costUSD ?? 0)) || null;
        const llm2TotalLatencyMs     = ((result.llm2Round1?.latencyMs ?? 0)
                                     +  (result.llm2Round2?.latencyMs ?? 0)) || null;
        const llm2FirstByteMs        = firstByteAt ? Math.round(firstByteAt - turnStartedAt) : null;

        telemetryUpdate(turnId, {
          planner: {
            promptVersion:      planner.promptVersion,
            rawResponse:        planner.rawResponse,
            validatedDecision:  planner.validatedDecision,
            finalUsedDecision: {
              context_types:          planner.context_types,
              reason:                 planner.reason,
              fallback_risk:          planner.fallback_risk,
              estimated_package_cost: planner.estimated_package_cost,
            },
            parseOk:            planner.parseOk,
            source:             planner.source,
            actualInputTokens:  planner.actualUsage?.inputTokens  ?? null,
            actualOutputTokens: planner.actualUsage?.outputTokens ?? null,
            actualCostUSD:      planner.actualCostUSD,
            // We don't pre-estimate planner cost; treat actual as the only
            // ground truth. Field present so the chip's accuracy math runs.
            estCostUSD:         planner.actualCostUSD,
            latencyMs:          planner.latencyMs,
          },
          package: {
            chosenTools:    planner.context_types,
            finalTools:     finalPackage?.types ?? [],
            summary:        finalPackage?.summary ?? 'none',
            errors:         finalPackage?.errors ?? {},
            totalSizeBytes: finalPackage?.totalSizeBytes ?? 0,
            estTokens:      finalPackage?.totalEstTokens ?? 0,
            estCostUSD:     llm2EstCostUSD,
          },
          llm2: {
            rawResponse:        finalAction?.rawResponse ?? null,
            source:             finalAction?.source ?? null,
            finalAction:        finalAction?.action ?? null,
            fallbackUsed:       result.fallbackUsed,
            fallbackRequested:  result.fallbackRequested,
            estCostUSD:         llm2EstCostUSD,
            actualInputTokens:  llm2ActualInputTokens || null,
            actualOutputTokens: llm2ActualOutputTokens || null,
            actualCostUSD:      llm2ActualCostUSD,
            latencyMs:          llm2TotalLatencyMs ? Math.round(llm2TotalLatencyMs) : null,
            streamFirstByteMs:  llm2FirstByteMs,
          },
          totals: {
            // Total turn latency includes manifest + planner + gather + LLM2 +
            // optional retry. Single source of truth for the chip's "total".
            wallClockMs: Math.round(turnEndedAt - turnStartedAt),
          },
        });
        telemetryMarkEnd(turnId);
        const finalRecord = telemetryFinalize(turnId);
        appendTelemetryChip(assistantRowEl, finalRecord);
      }
    } else {
      // ── Legacy flow (unchanged behavior) ────────────────────────────────
      const llm2StartedAt = performance.now();
      let llm2FirstByteAt = null;
      let actualUsage = null;

      await streamMessage({
        provider:     settings.provider,
        apiKey,
        model:        llm2Model,
        systemPrompt: SYSTEM_PROMPT,
        history:      prepareHistory(conversationHistory.slice(0, -1)),
        userText,
        screenshot,
        signal: abortController.signal,
        onChunk: (chunk) => {
          if (llm2FirstByteAt === null) llm2FirstByteAt = performance.now();
          fullText += chunk;
          bubbleEl.innerHTML = renderMarkdown(sealOpenFences(fullText));
          bubbleEl.classList.add('loading-cursor');
          scrollToBottom();
        },
        onUsage: (u) => { actualUsage = u; },
      });

      const llm2EndedAt = performance.now();
      bubbleEl.classList.remove('loading-cursor');

      conversationHistory.push({ role: 'assistant', textContent: fullText });

      if (turnId) {
        const chosenTools = screenshot ? ['viewport_screenshot'] : ['none'];
        const llm2ActualCost = costFromUsage(actualUsage, llm2Model);

        telemetryUpdate(turnId, {
          package: {
            chosenTools,
            estTokens:  oldFlowBaseline?.estInputTokens   ?? null,
            estCostUSD: oldFlowBaseline?.estInputCostUSD  ?? null,
          },
          llm2: {
            estCostUSD:         oldFlowBaseline?.estCostUSD ?? null,
            actualInputTokens:  actualUsage?.inputTokens    ?? null,
            actualOutputTokens: actualUsage?.outputTokens   ?? null,
            actualCostUSD:      llm2ActualCost,
            fallbackUsed:       false,
            latencyMs:          Math.round(llm2EndedAt - llm2StartedAt),
            streamFirstByteMs:  llm2FirstByteAt ? Math.round(llm2FirstByteAt - llm2StartedAt) : null,
          },
        });
        telemetryMarkEnd(turnId);
        const finalRecord = telemetryFinalize(turnId);
        appendTelemetryChip(assistantRowEl, finalRecord);
      } else if (settings.glanceEnabled && privacyStatus.state === 'blocked') {
        // Glance was on but the URL was blocked - explain why no context ran.
        appendPrivacyBlockedBadge(assistantRowEl, privacyStatus);
      }
    }

    // Cap history at 40 entries (~20 pairs)
    if (conversationHistory.length > 40) {
      conversationHistory = conversationHistory.slice(-38);
    }

    // Record the manifest for next turn's change-signal diff (after we
    // computed signals against the previous one above).
    if (manifest) signalTracker.record(manifest);

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

// ── Planner-flow orchestrator ─────────────────────────────────────────────

/**
 * Run the planner-driven LLM2 flow for one user turn.
 *
 * Sequence:
 *   1. Build the cost menu over the available tools (filtered by manifest).
 *   2. Call planContext (LLM1, GPT-5-nano) with the user prompt + manifest +
 *      change signals + cost menu. On any failure → defaultPlannerFailurePackage.
 *   3. Gather the chosen tools.
 *   4. Call askLLM2 (round 1).
 *   5. If round 1 returned request_more_context, gather the additional types,
 *      merge with the initial package, call askLLM2 (round 2). Max 1 retry.
 *   6. If round 2 also returned request_more_context, force a degraded
 *      provide_answer with a short user-facing fallback message.
 *
 * Aborts: signal is propagated into planContext and askLLM2 (both pass it to
 * fetch). Inter-step throwIfAborted checks short-circuit if the user hits stop
 * between phases. gatherTools is local + fast; no signal plumbing in MVP.
 */
async function runPlannerFlow({
  userPrompt,
  manifest,
  changeSignals,
  conversationHasPriorTurns,
  history,
  settings,
  privacyStatus,
  llm2Model,
  onChunk,
  resetBubble,
  signal,
}) {
  const llm2Provider = settings.provider;
  const llm2ApiKey   = getActiveApiKey(settings);

  // Filter tools to those available for this manifest. The orchestrator picks
  // the cost-menu options by intersecting ALLOWED_CONTEXT_TYPES with what's
  // available - planner only ever sees what we can actually gather.
  const availableTypes = ALLOWED_CONTEXT_TYPES.filter((t) => {
    if (t === 'viewport_dom') return manifest?.domReliable !== false;
    return true;
  });
  const costMenu = buildCostMenu(availableTypes, manifest, llm2Model);

  signal?.throwIfAborted?.();

  // 1. Planner. planContext never throws on model-side issues - it returns a
  // normalized decision (using the failure default when needed).
  const planner = await planContext({
    userPrompt,
    manifest,
    changeSignals,
    costMenu,
    conversationHasPriorTurns,
    apiKey:                settings.openaiApiKey ?? '',
    plannerModelId:        settings.plannerModelId ?? 'gpt-5-nano',
    defaultFailurePackage: settings.defaultPlannerFailurePackage ?? ['viewport_dom', 'viewport_screenshot'],
    signal,
  });

  signal?.throwIfAborted?.();

  // 2. Gather the chosen tools.
  const ctx = { manifest, settings, privacyStatus, llm2Model };
  const initialPackage = await gatherTools(planner.context_types, ctx);

  signal?.throwIfAborted?.();

  // 3. Round 1 LLM2.
  const round1StartedAt = performance.now();
  const action1 = await askLLM2({
    provider:     llm2Provider,
    apiKey:       llm2ApiKey,
    model:        llm2Model,
    systemPrompt: SYSTEM_PROMPT,
    history,
    userPrompt,
    package:      initialPackage,
    signal,
    onChunk,
  });
  const round1EndedAt = performance.now();

  let finalAction       = action1;
  let finalPackage      = initialPackage;
  let fallbackUsed      = false;
  let fallbackRequested = null;
  let llm2Round2        = null;

  const maxFallbacks = settings.plannerMaxFallbacks ?? 1;

  if (action1.action === 'request_more_context' && maxFallbacks >= 1) {
    fallbackUsed = true;
    fallbackRequested = action1.requested_context_types;

    signal?.throwIfAborted?.();

    // Clear any partial text streamed during round 1 (rare on Anthropic when
    // the model emits a brief text block before tool_use, but possible).
    resetBubble?.();

    // Gather additional tools and merge with the initial package so LLM2 sees
    // both. Tool dedup inside gatherTools means re-requested types are no-ops.
    const requestedPackage = await gatherTools(action1.requested_context_types, ctx);
    finalPackage = combinePackages([initialPackage, requestedPackage]);

    signal?.throwIfAborted?.();

    // 4. Round 2 LLM2.
    const round2StartedAt = performance.now();
    const action2 = await askLLM2({
      provider:     llm2Provider,
      apiKey:       llm2ApiKey,
      model:        llm2Model,
      systemPrompt: SYSTEM_PROMPT,
      history,
      userPrompt,
      package:      finalPackage,
      signal,
      onChunk,
    });
    const round2EndedAt = performance.now();
    llm2Round2 = { action: action2, latencyMs: round2EndedAt - round2StartedAt };

    if (action2.action === 'request_more_context') {
      // Spec: second consecutive request_more_context → force provide_answer.
      // Synthesize a degraded answer; the chip records source: 'raw-degrade'
      // and fallbackUsed: true so the user can see what happened.
      resetBubble?.();
      const fallbackText = "(I couldn't gather enough browser context to answer this confidently. Try rephrasing, scrolling to the relevant area, or asking about something visible on screen.)";
      finalAction = degradeToProvideAnswer({
        rawText:   fallbackText,
        provider:  llm2Provider,
        model:     llm2Model,
        usage:     action2.usage,
        costUSD:   action2.costUSD,
        latencyMs: action2.latencyMs,
        source:    'raw-degrade',
      });
      onChunk?.(fallbackText);
    } else {
      finalAction = action2;
    }
  }

  return {
    planner,
    initialPackage,
    finalPackage,
    finalAction,
    fallbackUsed,
    fallbackRequested,
    llm2Round1: { action: action1, latencyMs: round1EndedAt - round1StartedAt },
    llm2Round2,
  };
}

/**
 * Merge multiple gathered packages into one. Used when the round-1 package
 * needs to be combined with the round-2 add-ons. Errors merge; later errors
 * for the same key win (the more recent gather attempt is more relevant).
 */
function combinePackages(packages) {
  const out = {
    types:          [],
    textBlocks:     [],
    images:         [],
    totalSizeBytes: 0,
    totalEstTokens: 0,
    summary:        '',
    errors:         {},
  };
  const summaryParts = [];
  for (const p of packages) {
    if (!p) continue;
    out.types.push(...(p.types ?? []));
    out.textBlocks.push(...(p.textBlocks ?? []));
    out.images.push(...(p.images ?? []));
    out.totalSizeBytes += p.totalSizeBytes ?? 0;
    out.totalEstTokens += p.totalEstTokens ?? 0;
    if (p.summary && p.summary !== 'none') summaryParts.push(p.summary);
    Object.assign(out.errors, p.errors ?? {});
  }
  // Dedupe types while preserving order
  out.types = Array.from(new Set(out.types));
  out.summary = summaryParts.length ? summaryParts.join(' + ') : 'none';
  return out;
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
  if (!settings.glanceEnabled) return { state: 'disabled' };
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

  let blockedLabel = 'Glance off – blocked';
  if (category === 'internal') blockedLabel = 'Glance off – browser-internal page';
  else if (category === 'blocklist') blockedLabel = 'Glance off – blocked domain (privacy)';

  const labels = {
    enabled:  'Glance on',
    blocked:  blockedLabel,
    disabled: 'Glance off',
  };
  privacyLabel.textContent = labels[state] ?? '';

  const badgeClasses = { enabled: 'context-badge--active', blocked: 'context-badge--blocked', disabled: 'context-badge--disabled' };
  contextBadge.className = `context-badge ${badgeClasses[state] ?? ''}`;

  const badgeTexts = { enabled: ' With browser context', blocked: ' Private (protected)', disabled: ' Private' };
  contextBadge.lastChild.textContent = badgeTexts[state] ?? '';

  inputArea.classList.toggle('mode-enabled',  state === 'enabled');
  inputArea.classList.toggle('mode-blocked',  state === 'blocked');
  inputArea.classList.toggle('mode-disabled', state === 'disabled');
}

async function toggleGlance() {
  settings.glanceEnabled = !settings.glanceEnabled;
  await saveSettings({ glanceEnabled: settings.glanceEnabled });
  updateGlanceToggleUI();
  updatePrivacyUI();
}

function updateGlanceToggleUI() {
  glanceToggle.classList.toggle('active', settings.glanceEnabled);
  glanceToggle.classList.toggle('inactive', !settings.glanceEnabled);
  glanceToggle.setAttribute('aria-pressed', String(settings.glanceEnabled));
  glanceToggle.title = settings.glanceEnabled ? 'Glance: ON – click to disable' : 'Glance: OFF – click to enable';
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

function fitSelectWidth(sel) {
  const text = sel.options[sel.selectedIndex]?.text ?? '';
  const tmp = document.createElement('span');
  tmp.style.cssText = 'visibility:hidden;position:fixed;white-space:nowrap;font-family:inherit;font-size:12.5px;font-weight:500;letter-spacing:0.01em;';
  tmp.textContent = text;
  document.body.appendChild(tmp);
  sel.style.width = (tmp.offsetWidth + 16) + 'px';
  document.body.removeChild(tmp);
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
  fitSelectWidth(modelSelect);
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
  checkApiKeyWarning();
}

async function handleModelChange() {
  const provider = settings.provider ?? 'anthropic';
  const newModel = modelSelect.value;
  if (!newModel) return;

  fitSelectWidth(modelSelect);
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

// ── Telemetry chip & drawer ───────────────────────────────────────────────

/**
 * Attach a per-turn telemetry chip + collapsible drawer below an assistant
 * bubble. The chip click is handled via delegation in bindEvents.
 */
function appendTelemetryChip(rowEl, record) {
  if (!rowEl || !record) return;

  const { primary, pkg, fallbackTag, toneClass } = buildChipText(record);

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `telemetry-chip ${toneClass}`.trim();
  chip.dataset.turnId = record.turnId;
  chip.setAttribute('aria-expanded', 'false');
  chip.innerHTML = `
    <span>Telemetry</span>
    <span class="telemetry-chip__num">${escTel(primary)}</span>
    <span>· ${escTel(pkg)}${escTel(fallbackTag)}</span>
    <span class="telemetry-chip__caret"></span>
  `;

  const drawer = document.createElement('div');
  drawer.className = 'telemetry-drawer hidden';
  drawer.id = `telemetry-drawer-${record.turnId}`;
  drawer.innerHTML = buildDrawerInnerHtml(record);

  rowEl.appendChild(chip);
  rowEl.appendChild(drawer);
}

/**
 * Render a per-message badge explaining that Glance was on but the URL was
 * privacy-blocked, so no context ran for this turn. Lives in the same DOM
 * slot as the telemetry chip - one or the other, never both.
 */
function appendPrivacyBlockedBadge(rowEl, privacyStatus) {
  if (!rowEl) return;
  const reason = privacyStatus?.category === 'internal'
    ? 'Glance off this turn – browser-internal page'
    : privacyStatus?.category === 'blocklist'
      ? 'Glance off this turn – blocked domain'
      : 'Glance off this turn – privacy block';
  const el = document.createElement('div');
  el.className = 'privacy-blocked-badge';
  el.textContent = `🔒 ${reason}`;
  rowEl.appendChild(el);
}

function buildChipText(record) {
  const totals  = record.totals  ?? {};
  const llm2    = record.llm2    ?? {};
  const planner = record.planner;
  const pkg     = (record.package?.chosenTools ?? []).join(' + ') || 'none';

  let primary = '—';
  let toneClass = '';

  // Planner mode: show savings vs the old-flow baseline. Step 6 populates record.planner.
  if (planner && totals.deltaVsOldFlow != null) {
    if (totals.deltaVsOldFlow >= 0) {
      primary = `saved ${formatCost(totals.deltaVsOldFlow)}`;
      toneClass = 'telemetry-chip--saving';
    } else {
      primary = `cost +${formatCost(-totals.deltaVsOldFlow)}`;
      toneClass = 'telemetry-chip--penalty';
    }
  }
  // Calibration mode (Step 5): no planner, just show est vs actual.
  else if (totals.actualCostUSD != null && totals.estCostUSD != null) {
    primary = `est ${formatCost(totals.estCostUSD)} → actual ${formatCost(totals.actualCostUSD)}`;
  }
  // Unpriced model (e.g. OpenAI/Gemini before Stage E): tokens only.
  else if (llm2.actualInputTokens != null) {
    primary = `${llm2.actualInputTokens} in / ${llm2.actualOutputTokens ?? 0} out tok`;
  }

  const fallbackTag = planner
    ? (llm2.fallbackUsed ? ' · fallback' : '')
    : '';

  return { primary, pkg, fallbackTag, toneClass };
}

function buildDrawerInnerHtml(record) {
  const totals    = record.totals  ?? {};
  const baseline  = record.oldFlowBaseline ?? null;
  const llm2      = record.llm2    ?? {};
  const planner   = record.planner ?? null;
  const pkg       = record.package ?? {};
  const summary   = record.manifestSummary ?? null;
  const signals   = record.changeSignals ?? null;

  const trueSignals = signals
    ? Object.entries(signals).filter(([, v]) => v === true).map(([k]) => k)
    : [];
  const signalText = trueSignals.length ? trueSignals.join(', ') : 'none';
  const msSinceLast = signals?.ms_since_last_turn != null ? `${signals.ms_since_last_turn}ms` : '—';

  const flagText = summary?.flags?.length ? summary.flags.join(', ') : 'none';
  const errorPercent = totals.deltaVsEstPercent != null
    ? `${totals.deltaVsEstPercent > 0 ? '+' : ''}${totals.deltaVsEstPercent.toFixed(1)}%`
    : '—';
  const deltaCost = totals.deltaVsOldFlow;
  const deltaClass = deltaCost == null ? 'telemetry-row__value--muted'
                  : deltaCost >= 0      ? 'telemetry-row__value--positive'
                  :                       'telemetry-row__value--negative';
  const deltaText = deltaCost == null ? '—'
                  : deltaCost >= 0      ? `+${formatCost(deltaCost)}`
                  :                       `-${formatCost(-deltaCost)}`;

  return `
    <div class="telemetry-section">
      <div class="telemetry-section__title">Cost</div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Old-flow estimate</span>
        <span class="telemetry-row__value">${escTel(formatCost(baseline?.estCostUSD))}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">${planner ? 'New-flow actual' : 'Actual'}</span>
        <span class="telemetry-row__value">${escTel(formatCost(totals.actualCostUSD))}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Δ vs old flow</span>
        <span class="telemetry-row__value ${deltaClass}">${escTel(deltaText)}</span>
      </div>
      ${planner ? '' : '<div class="telemetry-section__notes">Calibration mode — planner not running. New flow lights up here once enabled.</div>'}
    </div>

    <div class="telemetry-section">
      <div class="telemetry-section__title">Estimate accuracy</div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Estimated</span>
        <span class="telemetry-row__value">${escTel(formatCost(totals.estCostUSD))}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Actual</span>
        <span class="telemetry-row__value">${escTel(formatCost(totals.actualCostUSD))}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Error</span>
        <span class="telemetry-row__value">${escTel(errorPercent)}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Tokens (in / out)</span>
        <span class="telemetry-row__value">${escTel(`${llm2.actualInputTokens ?? '—'} / ${llm2.actualOutputTokens ?? '—'}`)}</span>
      </div>
    </div>

    <div class="telemetry-section">
      <div class="telemetry-section__title">Decisions</div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Page</span>
        <span class="telemetry-row__value">${escTel(summary?.title || summary?.url || '—')}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Manifest</span>
        <span class="telemetry-row__value">${escTel(summary
          ? `${summary.viewport}, scrollY ${summary.scrollY}, vText ${summary.visibleTextLength}, full ${summary.fullTextLengthEstimate}`
          : '—')}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Flags</span>
        <span class="telemetry-row__value">${escTel(flagText)}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Change signals</span>
        <span class="telemetry-row__value">${escTel(signalText)}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Time since last turn</span>
        <span class="telemetry-row__value">${escTel(msSinceLast)}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Package</span>
        <span class="telemetry-row__value">${escTel((pkg.chosenTools ?? []).join(' + ') || 'none')}</span>
      </div>
      ${planner ? `
      <div class="telemetry-row">
        <span class="telemetry-row__label">Planner reason</span>
        <span class="telemetry-row__value">${escTel(planner.decision?.reason ?? '—')}</span>
      </div>` : ''}
    </div>

    <div class="telemetry-section">
      <div class="telemetry-section__title">Performance</div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Total turn</span>
        <span class="telemetry-row__value">${escTel(totals.latencyMs != null ? `${totals.latencyMs}ms` : '—')}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">LLM2 total</span>
        <span class="telemetry-row__value">${escTel(llm2.latencyMs != null ? `${llm2.latencyMs}ms` : '—')}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">LLM2 first byte</span>
        <span class="telemetry-row__value">${escTel(llm2.streamFirstByteMs != null ? `${llm2.streamFirstByteMs}ms` : '—')}</span>
      </div>
      ${planner?.latencyMs != null ? `
      <div class="telemetry-row">
        <span class="telemetry-row__label">Planner</span>
        <span class="telemetry-row__value">${escTel(`${planner.latencyMs}ms`)}</span>
      </div>` : ''}
    </div>
  `;
}

function summarizeManifest(m) {
  if (!m) return null;
  const flags = [];
  if (m.hasLargeVisibleImage)   flags.push('large-img');
  if (m.hasCanvas)              flags.push('canvas');
  if (m.hasSvg)                 flags.push('svg');
  if (m.hasTable)               flags.push('table');
  if (m.hasFormInput)           flags.push('form');
  if (m.hasFocusedElement)      flags.push(`focus:${m.focusedElementType}`);
  if (m.hasCrossOriginIframes)  flags.push('xorigin-iframes');
  if (!m.domReliable)           flags.push('dom-unreliable');
  if (m.sensitiveKeywordsHit)   flags.push(`sensitive:${m.sensitiveKeywordsHit}`);
  return {
    url:                    m.url,
    title:                  m.title,
    viewport:               `${m.viewportW}×${m.viewportH}`,
    scrollY:                m.scrollY,
    visibleTextLength:      m.visibleTextLength,
    fullTextLengthEstimate: m.fullTextLengthEstimate,
    visibleImageCount:      m.visibleImageCount,
    flags,
  };
}

function formatCost(usd) {
  if (usd == null) return '—';
  if (usd === 0)   return '$0';
  const abs = Math.abs(usd);
  if (abs >= 1)    return `$${usd.toFixed(2)}`;
  if (abs >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

function escTel(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clearConversation() {
  conversationHistory = [];
  signalTracker.reset();
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
        const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<code class="inline-code">${safe}</code>`;
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
  // extractAndRenderMath returns modified markdown (with PUA sentinels) + a slot restore fn
  const { markdown, restoreSlots } = extractAndRenderMath(text);
  let html = window.marked.parse(markdown);
  return stripColorStyles(restoreSlots(html));
}

function stripColorStyles(html) {
  return html.replace(/(<[^>]+?)\s+style="([^"]*)"/gi, (_, tag, style) => {
    const cleaned = style.replace(/\bcolor\s*:[^;"]*(;|(?="))/gi, '').trim().replace(/;$/, '').trim();
    return cleaned ? `${tag} style="${cleaned}"` : tag;
  });
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
      return `CODE${codeSlots.length - 1}`;
    })
    .replace(/`[^`\n]+`/g, (match) => {
      codeSlots.push(match);
      return `CODE${codeSlots.length - 1}`;
    });

  function renderSlot(latex, display) {
    const id = slots.length;
    if (latex.includes('AGMSLOT')) return latex;
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
    return `AGMSLOT${id}AGMSLOT`;
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
    // Display: multi-line $ ... $ — runs before bare heuristics so outer $ captures whole expression first
    .replace(/\$\s*\n([\s\S]+?)\n\s*\$/g, (_, latex) => renderSlot(latex, true))
    // Inline: $ ... $ (single line, no template-literal ${, no backticks)
    .replace(/\$(?!\{)([^\n$`]+?)\$/g, (_, latex) => renderSlot(latex, false))
    // Display: bare brackets [ … ] wrapping LaTeX with no $ delimiter (model dropped delimiters).
    // Heuristic: must contain at least one \cmd backslash-letter sequence, no nested brackets,
    // and not be immediately followed by ( - which would make it a Markdown link reference.
    .replace(/\[\s*([^\[\]]*?\\[a-zA-Z]+[^\[\]]*?)\s*\](?!\()/g,
      (_, latex) => renderSlot(latex, true))
    // Inline: bare parens ( … ) wrapping LaTeX with no $ delimiter
    .replace(/\(\s*([^()]*?\\[a-zA-Z]+[^()]*?)\s*\)/g,
      (_, latex) => renderSlot(latex, false))
    // Cleanup: unwrap leftover brackets/parens around an already-extracted math slot
    .replace(/[\[(]\s*(AGMSLOT\d+AGMSLOT)\s*[\])]/g, (_, s) => s);

  // Restore shielded code blocks - marked will process them normally
  markdown = markdown.replace(/CODE(\d+)/g, (_, i) => codeSlots[parseInt(i, 10)]);

  function restoreSlots(html) {
    return html.replace(/AGMSLOT(\d+)AGMSLOT/g, (_, i) => {
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
