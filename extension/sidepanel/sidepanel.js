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
import { planContext } from '../lib/planner.js';
import { gatherTools, extractViewportDomInPage, emptyPackage } from '../lib/context-tools.js';
import { askLLM2, degradeToProvideAnswer, buildBrowserContextText } from '../lib/llm2-protocol.js';

// ── State ─────────────────────────────────────────────────────────────────

let settings = null;
let currentTab = null;
let isStreaming = false;
let abortController = null;

// In-session glance state: true = glance active this session.
// Controlled by the sidebar toggle; does NOT write to storage.
// Resets when settings.glanceEnabled is turned OFF or the OpenAI key is removed.
let glanceSessionActive = false;

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
const plannerToggle    = $('planner-toggle');
const shadowToggle     = $('shadow-toggle');
const inputArea        = document.querySelector('.input-area');
const privacyBar       = $('privacy-bar');
const privacyLabel     = $('privacy-label');
const apiKeyWarning    = $('api-key-warning');
const setupHero        = $('setup-hero');
const contextBadge     = $('context-badge');
const providerToggle   = $('provider-toggle');
const modelSelect      = $('model-select');

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  settings = await getSettings();
  glanceSessionActive = settings.glanceEnabled && !!settings.openaiApiKey;
  await refreshTabInfo();
  bindEvents();
  renderControlsBar();
  updatePrivacyUI();
  updateGlanceToggleUI();
  updatePlannerToggleUI();
  updateShadowToggleUI();
  updateDevModeUI();
  checkApiKeyWarning();
  checkSetupHero();

  onSettingsChanged((changed) => {
    Object.assign(settings, changed);

    // Sync session state with persistent settings changes
    if ('glanceEnabled' in changed) {
      if (!changed.glanceEnabled) {
        glanceSessionActive = false;  // settings turned OFF → kill session
      } else if (!!settings.openaiApiKey) {
        glanceSessionActive = true;   // settings turned ON → activate session
      }
    }
    if ('openaiApiKey' in changed && !changed.openaiApiKey) {
      glanceSessionActive = false;    // key removed → kill session
    }

    renderControlsBar();
    updatePrivacyUI();
    updateGlanceToggleUI();
    updatePlannerToggleUI();
    updateShadowToggleUI();
    updateDevModeUI();
    checkApiKeyWarning();
    checkSetupHero();
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
  plannerToggle.addEventListener('click', togglePlannerFlow);
  shadowToggle.addEventListener('click', toggleShadowOldFlow);

  // Provider chips - click switches provider, or opens Settings if no key.
  providerToggle.querySelectorAll('.provider-chip').forEach((chip) => {
    chip.addEventListener('click', () => handleProviderClick(chip.dataset.provider));
  });

  // Model dropdown - save the new choice for the active provider.
  modelSelect.addEventListener('change', handleModelChange);

  $('warning-settings-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  });

  $('hero-settings-btn').addEventListener('click', () => {
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

  // Auto-update the glancability badge when the user switches tabs or the
  // active tab navigates to a new URL.
  chrome.tabs.onActivated.addListener(() => refreshTabInfo());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab.active || changeInfo.status !== 'complete') return;
    refreshTabInfo();
  });

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

  let statusIndicator;
  let thinkingTimer = null;
  if (canMorph) {
    let morphedRow = null;
    const transition = document.startViewTransition(() => {
      welcome.remove();
      const { rowEl } = appendUserBubble(text);
      // Skip the default fade-up so the view transition owns the entry motion.
      rowEl.style.animation = 'none';
      rowEl.style.viewTransitionName = 'welcome-hero';
      morphedRow = rowEl;
      statusIndicator = appendStatusIndicator();
    });
    // Wait for the callback to run so statusIndicator is set before we proceed.
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
    statusIndicator = appendStatusIndicator();
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
    const glanceCanInspect = glanceSessionActive && privacyStatus.state === 'enabled';
    // In dev mode the planner is gated by its own toggle (_internalUsePlannerFlow).
    // In production mode (developerTelemetry off) the planner always follows Glance.
    let useNewFlow = glanceCanInspect && (settings.developerTelemetry ? !!settings._internalUsePlannerFlow : true);

    // Page inspection: build manifest whenever Glance can inspect (used by
    // both telemetry and the planner). Capture screenshot + page-context only
    // for the legacy flow - the planner picks its own tools.
    let screenshot     = null;
    let pageContext    = null;
    let manifest       = null;
    let manifestError  = null;
    if (glanceCanInspect) {
      ({ manifest, error: manifestError } = await buildManifest());
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
    const historyChars = conversationHistory.slice(0, -1).reduce((s, m) => s + (m.textContent?.length ?? 0), 0);
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
          maxImageWidth: settings.maxImageWidth ?? 1280,
        })
      : null;

    const telemetryEnabled = settings.developerTelemetry && glanceSessionActive && privacyStatus.state === 'enabled';
    const turnId = telemetryEnabled
      ? telemetryStart({
          flow:            useNewFlow ? 'planner' : 'legacy',
          llm2Provider:    settings.provider,
          llm2Model,
          plannerProvider: useNewFlow ? settings.plannerProvider : null,
          plannerModel:    useNewFlow ? settings.plannerModelId   : null,
          manifestSummary: summarizeManifest(manifest),
          manifestError,
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

    abortController = new AbortController();
    let fullText = '';
    let assistantRowEl = null;
    let bubbleEl       = null;

    // Creates the assistant bubble on first chunk, removing the status indicator.
    // Safe to call multiple times — subsequent calls are no-ops.
    const ensureBubble = () => {
      if (bubbleEl) return;
      clearTimeout(thinkingTimer);
      statusIndicator.remove();
      ({ rowEl: assistantRowEl, bubbleEl } = appendAssistantBubble(''));
    };

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
        ensureBubble();
        fullText += chunk;
        bubbleEl.innerHTML = renderMarkdown(sealOpenFences(fullText));
        bubbleEl.classList.add('loading-cursor');
        scrollToBottom();
      };
      const resetBubble = () => {
        ensureBubble();
        fullText = '';
        firstByteAt = null;
        bubbleEl.innerHTML = '';
      };
      // Fired by runPlannerFlow just before LLM2 is invoked (both none and
      // context paths). Starts the 2s timer that transitions the indicator to
      // "Thinking..." if the model hasn't responded yet.
      const onLLM2Start = () => {
        thinkingTimer = setTimeout(() => statusIndicator.setPhase('thinking'), 2000);
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
        onLLM2Start,
        signal: abortController.signal,
      });

      ensureBubble(); // guarantee bubble exists even if no chunks arrived
      bubbleEl.classList.remove('loading-cursor');
      const turnEndedAt = performance.now();

      // Retroactively enrich the user history entry with the browser-context
      // block that was actually sent to LLM2 this turn. This ensures that on
      // the next turn, LLM2 sees the DOM text in history even when the planner
      // picks "none" — without this, "none" means zero context because the
      // enriched message was never stored back into conversationHistory.
      // Screenshots are excluded: they're never replayed in history to save tokens.
      const sentCtxText = buildBrowserContextText(result.finalPackage);
      if (sentCtxText) {
        const userEntry = conversationHistory[conversationHistory.length - 1];
        const summaryPart = result.finalPackage?.summary && result.finalPackage.summary !== 'none'
          ? `(Browser context summary: ${result.finalPackage.summary})`
          : '';
        const enrichedParts = [sentCtxText];
        if (summaryPart) enrichedParts.push(summaryPart);
        enrichedParts.push(text);
        userEntry.textContent = enrichedParts.join('\n\n');
      }

      conversationHistory.push({ role: 'assistant', textContent: fullText });

      // Shadow old-flow: capture a screenshot and make a real LLM2 call using
      // the legacy screenshot path, then record its actual token counts. This
      // gives a true actual-vs-actual comparison instead of actual-vs-estimated.
      // Only runs when the shadow toggle is ON. Non-fatal — failures are silent.
      if (settings.developerTelemetry && settings._internalShadowOldFlow && turnId) {
        try {
          const shadowScreenshot = await captureScreenshot();
          if (shadowScreenshot) {
            let shadowUsage = null;
            let shadowOutputText = '';
            await streamMessage({
              provider:     settings.provider,
              apiKey,
              model:        llm2Model,
              systemPrompt: SYSTEM_PROMPT,
              history:      prepareHistory(conversationHistory.slice(0, -2)),
              userText:     text,
              screenshot:   shadowScreenshot,
              onChunk:      (chunk) => { shadowOutputText += chunk; },
              onUsage:      (u) => { shadowUsage = u; },
            });
            telemetryUpdate(turnId, {
              shadowOldFlow: {
                actualInputTokens:  shadowUsage?.inputTokens  ?? null,
                actualOutputTokens: shadowUsage?.outputTokens ?? null,
                actualCostUSD:      shadowUsage ? costFromUsage(shadowUsage, llm2Model) : null,
                inputUserText:      text,
                outputText:         shadowOutputText || null,
              },
            });
          }
        } catch { /* shadow failures are non-fatal */ }
      }

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
          io: {
            plannerUserPrompt: text,
            plannerCostMenu:   result.costMenu,
            toolCostMenu:      result.toolCostMenu ?? [],
            r1PackageTypes:    result.initialPackage?.types    ?? [],
            r1PackageText:     previewPackageText(result.initialPackage),
            r1ImageCount:      result.initialPackage?.images?.length ?? 0,
            r1RawResponse:     result.llm2Round1?.action?.rawResponse ?? null,
            r1Action:          result.llm2Round1?.action?.action       ?? null,
            r1RequestedTypes:  result.llm2Round1?.action?.requested_context_types ?? null,
            r1RequestReason:   result.llm2Round1?.action?.reason       ?? null,
            r2PackageTypes:    result.requestedPackage?.types  ?? null,
            r2PackageText:     previewPackageText(result.requestedPackage),
            r2ImageCount:      result.requestedPackage?.images?.length ?? null,
            r2RawResponse:     result.llm2Round2?.action?.rawResponse ?? null,
            r2Action:          result.llm2Round2?.action?.action       ?? null,
          },
          planner: {
            promptVersion:      planner.promptVersion,
            rawResponse:        planner.rawResponse,
            validatedDecision:  planner.validatedDecision,
            finalUsedDecision: {
              context_types: planner.context_types,
              reason:        planner.reason,
              fallback_risk: planner.fallback_risk,
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
            // Pre-gather estimate: from the cost menu (manifest-based, before extraction).
            // Compare against estTokens (post-gather, real content) to see estimation error.
            preGatherEstTokens: (planner.context_types ?? []).reduce((s, t) => {
              const entry = (result.costMenu ?? []).find((e) => e.type === t);
              return s + (entry?.est_tokens ?? 0);
            }, 0),
            estCostUSD:     llm2EstCostUSD,
          },
          llm2: {
            modelId:            llm2Model,
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

      thinkingTimer = setTimeout(() => statusIndicator.setPhase('thinking'), 2000);

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
          ensureBubble();
          fullText += chunk;
          bubbleEl.innerHTML = renderMarkdown(sealOpenFences(fullText));
          bubbleEl.classList.add('loading-cursor');
          scrollToBottom();
        },
        onUsage: (u) => { actualUsage = u; },
      });

      const llm2EndedAt = performance.now();
      ensureBubble(); // guarantee bubble exists even if no chunks arrived
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
            modelId:            llm2Model,
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
      } else if (glanceSessionActive && privacyStatus.state === 'blocked') {
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
    clearTimeout(thinkingTimer);
    statusIndicator.remove();
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
 *   1. Pre-extract DOM (if available) for an exact post-sanitization token count.
 *   2. Build toolCostMenu (actual tools, for orchestrator) and plannerCostMenu
 *      (abstract: none vs context_needed, for LLM1).
 *   3. Call planContext (LLM1) — binary decision: none or context_needed.
 *   4a. none → stream LLM2 directly. No tool gathering, no structured-output
 *       protocol, no fallback loop. The protocol machinery only makes sense
 *       when context is present and sufficiency needs evaluation.
 *   4b. context_needed → pick the cheapest available tool from toolCostMenu,
 *       gather it, call askLLM2 (round 1) with full structured-output protocol.
 *   5. If round 1 returned request_more_context, gather additional types,
 *      merge packages, call askLLM2 (round 2). Max 1 retry.
 *   6. If round 2 also returned request_more_context, force a degraded
 *      provide_answer with a short user-facing fallback message.
 *
 * Aborts: signal is propagated into planContext and askLLM2. Inter-step
 * throwIfAborted checks short-circuit if the user hits stop between phases.
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
  onLLM2Start,
  signal,
}) {
  const llm2Provider = settings.provider;
  const llm2ApiKey   = getActiveApiKey(settings);

  // Actual context tools available for this manifest.
  // viewport_dom excluded when domReliable is false (PDF viewers, canvas-dominant pages).
  const actualToolTypes = ['viewport_dom', 'viewport_screenshot'].filter(
    (t) => t !== 'viewport_dom' || manifest?.domReliable !== false
  );

  // Pre-extract the DOM now so the cost menu gets the exact post-sanitization
  // token count rather than the manifest-based formula (which can be off by 50%+).
  // executeScript is pure JS in the page — no API call, no cost, ~5-30ms.
  // If the orchestrator ends up gathering viewport_dom, the result is reused;
  // otherwise it is discarded.
  let preExtractedDom = null;
  if (actualToolTypes.includes('viewport_dom') && privacyStatus?.state === 'enabled' && manifest?.tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: manifest.tabId },
        func:   extractViewportDomInPage,
      });
      preExtractedDom = results?.[0]?.result ?? null;
    } catch { /* non-fatal — gatherTools will re-extract if needed */ }
  }

  // Tool cost menu (actual tools) — used by the orchestrator to pick the
  // cheapest tool and stored in telemetry for the cost-breakdown display.
  const domTokenOverrides = preExtractedDom
    ? { viewport_dom: estimateTextTokens(preExtractedDom.content?.length ?? 0) }
    : {};
  const toolCostMenu = buildCostMenu(actualToolTypes, manifest, llm2Model, domTokenOverrides);

  // Select the best context tool. Default to cheapest, but prefer screenshot
  // when the viewport is visually dominated: a large image is present, many
  // images are visible, and there is little visible text. In those cases DOM
  // extraction returns mostly nav/UI chrome rather than the content the user
  // is actually looking at, so the token-cost difference is not meaningful.
  const isVisuallyDominated =
    manifest?.hasLargeVisibleImage === true &&
    (manifest?.visibleImageCount ?? 0) > 5  &&
    (manifest?.visibleTextLength ?? 0) < 2000;

  const cheapestTool = toolCostMenu.length
    ? toolCostMenu.reduce((min, e) => e.est_tokens <= min.est_tokens ? e : min)
    : null;

  const bestTool = (() => {
    if (!toolCostMenu.length) return null;
    if (isVisuallyDominated) {
      const screenshot = toolCostMenu.find((e) => e.type === 'viewport_screenshot');
      if (screenshot) return screenshot;
    }
    return cheapestTool;
  })();

  // Planner cost menu — two abstract options. LLM1 sees "context_needed" as a
  // single line-item whose cost equals the tool we would actually gather.
  // This gives the planner accurate cost information without exposing the DOM vs
  // screenshot distinction that it no longer needs to make.
  const plannerCostMenu = [
    { type: 'none',           est_tokens: 0,                           est_cost_usd: 0 },
    { type: 'context_needed', est_tokens: bestTool?.est_tokens  ?? 0,  est_cost_usd: bestTool?.est_cost_usd ?? 0 },
  ];

  // DOM-unreliable pages (PDFs, canvas, image viewers): the screenshot is the
  // only source of truth and must be re-captured every turn because images are
  // not stored in conversation history. Skip LLM1 — the decision is always
  // context_needed → viewport_screenshot, with no routing benefit from the planner.
  const skipPlanner = manifest?.domReliable === false;

  signal?.throwIfAborted?.();

  let planner;
  if (skipPlanner) {
    planner = {
      context_types:     ['context_needed'],
      reason:            'DOM-unreliable page — screenshot re-captured every turn (images not in history)',
      fallback_risk:     null,
      rawResponse:       null,
      validatedDecision: ['context_needed'],
      finalUsedDecision: {
        context_types: ['context_needed'],
        reason:        'DOM-unreliable page — screenshot re-captured every turn (images not in history)',
        fallback_risk: null,
      },
      parseOk:       true,
      source:        'skipped-dom-unreliable',
      promptVersion: 'n/a',
      actualUsage:   null,
      actualCostUSD: null,
      latencyMs:     0,
    };
  } else {
    // 1. Planner (LLM1). planContext never throws — returns a normalized decision.
    planner = await planContext({
      userPrompt,
      manifest,
      changeSignals,
      costMenu:              plannerCostMenu,
      conversationHasPriorTurns,
      apiKey:                settings.openaiApiKey ?? '',
      plannerModelId:        settings.plannerModelId ?? 'gpt-5-nano',
      defaultFailurePackage: ['context_needed'],
      signal,
    });
  }

  signal?.throwIfAborted?.();

  const isNone = !skipPlanner && planner.context_types.includes('none');

  // ── None path: no browser context needed, stream LLM2 directly ────────────
  // Skips tool gathering and the structured-output protocol entirely because
  // those exist to evaluate context sufficiency — irrelevant when there is none.
  if (isNone) {
    const nonePackage = emptyPackage();

    // The annotation lets LLM2 answer confidently from history without wondering
    // why no context was attached. Sent to the model but not stored in history.
    const annotatedPrompt = conversationHasPriorTurns
      ? `${userPrompt}\n\n[AutoGlance: page unchanged since last turn — answer from conversation history, no new context needed]`
      : userPrompt;

    onLLM2Start?.();
    const round1StartedAt = performance.now();
    let noneUsage = null;
    let noneText  = '';
    await streamMessage({
      provider:     llm2Provider,
      apiKey:       llm2ApiKey,
      model:        llm2Model,
      systemPrompt: SYSTEM_PROMPT,
      history,
      userText:     annotatedPrompt,
      screenshot:   null,
      signal,
      onChunk: (chunk) => { noneText += chunk; onChunk?.(chunk); },
      onUsage: (u)     => { noneUsage = u; },
    });
    const round1EndedAt = performance.now();

    const pricing  = getPricing(llm2Model);
    const noneCost = noneUsage && pricing
      ? ((noneUsage.inputTokens  ?? 0) / 1_000_000) * pricing.inUSDPer1M
      + ((noneUsage.outputTokens ?? 0) / 1_000_000) * pricing.outUSDPer1M
      : null;

    const finalAction = {
      action:                  'provide_answer',
      answer:                  noneText,
      requested_context_types: [],
      reason:                  null,
      usage:                   noneUsage,
      costUSD:                 noneCost,
      latencyMs:               Math.round(round1EndedAt - round1StartedAt),
      provider:                llm2Provider,
      model:                   llm2Model,
      rawResponse:             noneText,
      source:                  'direct-stream',
    };

    return {
      planner,
      costMenu:          plannerCostMenu,
      toolCostMenu,
      initialPackage:    nonePackage,
      requestedPackage:  null,
      finalPackage:      nonePackage,
      finalAction,
      fallbackUsed:      false,
      fallbackRequested: null,
      llm2Round1:        { action: finalAction, latencyMs: round1EndedAt - round1StartedAt },
      llm2Round2:        null,
    };
  }

  // ── Context path: pick best tool, gather, orchestrate ────────────────────
  const chosenToolType = bestTool?.type ?? 'viewport_screenshot';
  const ctx = { manifest, settings, privacyStatus, llm2Model, preExtractedDom };
  const initialPackage = await gatherTools([chosenToolType], ctx);

  signal?.throwIfAborted?.();

  // Round 1 LLM2.
  onLLM2Start?.();
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

  let finalAction        = action1;
  let finalPackage       = initialPackage;
  let fallbackUsed       = false;
  let fallbackRequested  = null;
  let llm2Round2         = null;
  let requestedPackage   = null;

  const maxFallbacks = settings.plannerMaxFallbacks ?? 1;

  if (action1.action === 'request_more_context' && maxFallbacks >= 1) {
    fallbackUsed      = true;
    fallbackRequested = action1.requested_context_types;

    signal?.throwIfAborted?.();

    // Clear any partial text streamed during round 1 (rare on Anthropic when
    // the model emits a brief text block before tool_use, but possible).
    resetBubble?.();

    // Gather additional tools and merge with the initial package so LLM2 sees
    // both. Tool dedup inside gatherTools means re-requested types are no-ops.
    requestedPackage = await gatherTools(action1.requested_context_types, ctx);
    finalPackage     = combinePackages([initialPackage, requestedPackage]);

    signal?.throwIfAborted?.();

    // Round 2 LLM2.
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
      // Second consecutive request_more_context → force provide_answer.
      // Chip records source: 'raw-degrade' and fallbackUsed: true.
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
    costMenu:         plannerCostMenu,
    toolCostMenu,
    initialPackage,
    requestedPackage,
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
  if (!glanceSessionActive) return { state: 'disabled' };
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

  const badgeTexts = { enabled: ' With browser context', blocked: ' Unable to view this page, either due to privacy concerns or because of Google Chrome\'s screen capture policy. Please try a different page.', disabled: ' Private' };
  contextBadge.lastChild.textContent = badgeTexts[state] ?? '';

  inputArea.classList.toggle('mode-enabled',  state === 'enabled');
  inputArea.classList.toggle('mode-blocked',  state === 'blocked');
  inputArea.classList.toggle('mode-disabled', state === 'disabled');
}

function toggleGlance() {
  // Locked when no key or settings master switch is OFF.
  if (!settings.openaiApiKey || !settings.glanceEnabled) return;
  glanceSessionActive = !glanceSessionActive;
  updateGlanceToggleUI();
  updatePrivacyUI();
}

function updateGlanceToggleUI() {
  const hasKey = !!settings.openaiApiKey;
  const locked = !hasKey || !settings.glanceEnabled;

  glanceToggle.classList.toggle('active',   glanceSessionActive);
  glanceToggle.classList.toggle('inactive', !glanceSessionActive);
  glanceToggle.classList.toggle('locked',   locked);
  glanceToggle.setAttribute('aria-pressed', String(glanceSessionActive));

  if (!hasKey) {
    glanceToggle.title = 'OpenAI API key required — add one in Settings';
  } else if (!settings.glanceEnabled) {
    glanceToggle.title = 'Glance is disabled — enable it in Settings to use this feature';
  } else {
    glanceToggle.title = glanceSessionActive ? 'Glance: ON – click to pause' : 'Glance: paused – click to resume';
  }
}

async function togglePlannerFlow() {
  settings._internalUsePlannerFlow = !settings._internalUsePlannerFlow;
  await saveSettings({ _internalUsePlannerFlow: settings._internalUsePlannerFlow });
  updatePlannerToggleUI();
}

function updatePlannerToggleUI() {
  const on = !!settings._internalUsePlannerFlow;
  plannerToggle.setAttribute('aria-pressed', String(on));
  plannerToggle.title = on ? 'Planner: ON – smart context routing' : 'Planner: OFF – legacy screenshot';
}

async function toggleShadowOldFlow() {
  settings._internalShadowOldFlow = !settings._internalShadowOldFlow;
  await saveSettings({ _internalShadowOldFlow: settings._internalShadowOldFlow });
  updateShadowToggleUI();
}

function updateShadowToggleUI() {
  const on = !!settings._internalShadowOldFlow;
  shadowToggle.setAttribute('aria-pressed', String(on));
  shadowToggle.title = on
    ? 'Shadow: ON – running real old-flow call for cost comparison (doubles API cost)'
    : 'Shadow: OFF – old-flow cost is estimated';
}

function updateDevModeUI() {
  const dev = !!settings.developerTelemetry;
  plannerToggle.classList.toggle('hidden', !dev);
  shadowToggle.classList.toggle('hidden', !dev);
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

function checkSetupHero() {
  document.body.classList.toggle('setup-mode', !settings.openaiApiKey);
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

function appendStatusIndicator() {
  const row = document.createElement('div');
  row.className = 'message-row message-row--assistant';
  row.innerHTML = `
    <div class="status-indicator">
      <span class="status-indicator__label">Taking a glance</span>
      <div class="status-indicator__dots">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>`;
  messagesEl.appendChild(row);
  scrollToBottom();
  return {
    setPhase(phase) {
      const label = row.querySelector('.status-indicator__label');
      if (label) label.textContent = phase === 'thinking' ? 'Thinking' : 'Taking a glance';
    },
    remove() { row.remove(); },
  };
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
  const el = document.createElement('div');
  el.className = 'privacy-blocked-badge';
  el.textContent = '🔒 Unable to view this page, either due to privacy concerns or because of Google Chrome\'s screen capture policy. Please try a different page.';
  rowEl.appendChild(el);
}

function buildChipText(record) {
  const totals  = record.totals  ?? {};
  const llm2    = record.llm2    ?? {};
  const planner = record.planner;
  // Use finalTools (actual tool gathered) for the chip label; fall back to
  // chosenTools (planner decision: none / context_needed) when no tool was gathered.
  const pkgTools = record.package?.finalTools?.length
    ? record.package.finalTools
    : (record.package?.chosenTools ?? []);
  const pkg = pkgTools.join(' + ') || 'none';

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
  const shadow    = record.shadowOldFlow   ?? null;
  const llm2      = record.llm2    ?? {};
  const planner   = record.planner ?? null;
  const pkg       = record.package ?? {};
  const summary      = record.manifestSummary ?? null;
  const manifestErr  = record.manifestError  ?? null;
  const signals      = record.changeSignals ?? null;

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

  const deltaPct = totals.deltaVsOldFlowPercent;
  const deltaPctClass = deltaPct == null ? 'telemetry-row__value--muted'
                      : deltaPct >= 0    ? 'telemetry-row__value--positive'
                      :                    'telemetry-row__value--negative';
  const deltaPctText = deltaPct == null ? '—'
                     : deltaPct >= 0    ? `${deltaPct.toFixed(1)}% cheaper`
                     :                    `${Math.abs(deltaPct).toFixed(1)}% more expensive`;

  const flowPath = buildFlowPath(record);
  const io = record.io ?? null;

  // ── Build I/O panel content strings (plain text, escaped when inserted) ──
  let plannerInputText = null;
  if (io) {
    const costLines = (io.plannerCostMenu ?? []).map((o) => {
      const tok  = o.est_tokens != null ? `${o.est_tokens} tok` : '— tok';
      const cost = o.est_cost_usd != null ? ` ($${o.est_cost_usd.toFixed(4)})` : '';
      return `  ${o.type.padEnd(22)}${tok}${cost}`;
    }).join('\n');
    const activeSignals = Object.entries(record.changeSignals ?? {})
      .filter(([k, v]) => v === true && k !== 'is_first_message' && k !== 'ms_since_last_turn')
      .map(([k]) => k);
    const ms = summary; // manifestSummary
    const manifestLines = ms ? [
      `  url:                  ${ms.url ?? '—'}`,
      `  title:                ${ms.title ?? '—'}`,
      `  viewport:             ${ms.viewport ?? '—'}`,
      `  scroll_y:             ${ms.scrollY ?? 0}`,
      `  visible_text_length:  ${ms.visibleTextLength ?? 0}`,
      `  full_text_length:     ${ms.fullTextLengthEstimate ?? 0}`,
      `  visible_images:       ${ms.visibleImageCount ?? 0}`,
      `  flags:                ${ms.flags?.length ? ms.flags.join(', ') : 'none'}`,
    ].join('\n') : '  (not available)';

    plannerInputText = [
      `User prompt: "${(io.plannerUserPrompt ?? '').slice(0, 300)}"`,
      ``,
      `Page manifest:`,
      manifestLines,
      ``,
      `Cost options:`,
      costLines || '  (none)',
      ``,
      `Change signals: ${activeSignals.length ? activeSignals.join(', ') : 'none'}`,
      `Has prior turns: ${record.changeSignals?.is_first_message === true ? 'no (first message)' : 'yes'}`,
    ].join('\n');
  }

  // Build routing I/O panel text shown between planner output and context gathered.
  let routingPanelText = null;
  if (io && planner) {
    const routingDecision = (pkg.chosenTools ?? []).join(', ') || 'none';
    const toolCostMenuIo  = io.toolCostMenu ?? [];
    const chosenToolName  = pkg.finalTools?.[0] ?? null;
    const routingLines    = [
      `Decision:      ${routingDecision}`,
      `Reason:        ${planner.finalUsedDecision?.reason ?? '—'}`,
    ];
    if (planner.finalUsedDecision?.fallback_risk != null) {
      routingLines.push(`Fallback risk: ${planner.finalUsedDecision.fallback_risk}`);
    }
    if (routingDecision === 'none') {
      routingLines.push('');
      routingLines.push('Streaming LLM2 directly — no tool gathered.');
    } else if (toolCostMenuIo.length > 0) {
      routingLines.push('');
      routingLines.push('Tool cost comparison:');
      for (const entry of toolCostMenuIo) {
        const isChosen = entry.type === chosenToolName;
        const tok  = entry.est_tokens  != null ? `${String(entry.est_tokens).padStart(5)} tok` : '    — tok';
        const cost = entry.est_cost_usd != null ? `  ($${entry.est_cost_usd.toFixed(5)})` : '';
        const mark = isChosen ? '  ← chosen' : '';
        routingLines.push(`  ${entry.type.padEnd(22)}${tok}${cost}${mark}`);
      }
    }
    routingPanelText = routingLines.join('\n');
  }

  // Skip the "Context gathered" panel when none path was taken (no tool gathered).
  const r1HasContent = io && (io.r1PackageTypes?.length > 0 || io.r1ImageCount > 0);
  const r1ContextText = r1HasContent
    ? buildContextPanelText(io.r1PackageTypes, io.r1PackageText, io.r1ImageCount)
    : null;
  const r1ResponseText = io
    ? buildResponsePanelText(io.r1Action, io.r1RawResponse, io.r1RequestedTypes, io.r1RequestReason)
    : null;
  const r2ContextText = (io && io.r2PackageTypes)
    ? buildContextPanelText(io.r2PackageTypes, io.r2PackageText, io.r2ImageCount)
    : null;
  const r2ResponseText = (io && io.r2Action)
    ? buildResponsePanelText(io.r2Action, io.r2RawResponse, null, null)
    : null;

  // Output-size comparison: new-flow final answer vs shadow old-flow answer.
  const newFlowFinalText  = io?.r2RawResponse ?? io?.r1RawResponse ?? null;
  const newFlowOutputChars  = newFlowFinalText  != null ? newFlowFinalText.length  : null;
  const shadowOutputChars   = shadow?.outputText != null ? shadow.outputText.length : null;
  let outputSizeRow = '';
  if (newFlowOutputChars != null && shadowOutputChars != null) {
    const diff    = newFlowOutputChars - shadowOutputChars;
    const absDiff = Math.abs(diff);
    const pct     = shadowOutputChars > 0 ? ((diff / shadowOutputChars) * 100).toFixed(1) : null;
    const direction = diff < 0 ? 'shorter' : diff > 0 ? 'longer' : 'same';
    const cls     = diff < 0 ? 'telemetry-row__value--positive'
                  : diff > 0 ? 'telemetry-row__value--negative'
                  :             'telemetry-row__value--muted';
    const deltaLabel = diff === 0 ? 'same length'
      : `${absDiff} chars ${direction}${pct != null ? ` (${pct}%)` : ''}`;
    outputSizeRow = `
      <div class="telemetry-row">
        <span class="telemetry-row__label">Output chars (new / shadow)</span>
        <span class="telemetry-row__value">${escTel(`${newFlowOutputChars} / ${shadowOutputChars}`)}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Output size delta</span>
        <span class="telemetry-row__value ${cls}">${escTel(deltaLabel)}</span>
      </div>`;
  }

  // Clean routing delta: cost saving attributable purely to context routing,
  // with output-length variance factored out.
  //
  // raw_delta = shadow.actualCostUSD - newFlow.totalCostUSD
  //   (positive = new flow saved money)
  //
  // output_variance_cost = (shadow.outputTokens - llm2.outputTokens) × outRate/1M
  //   (the portion of raw_delta explained by the shadow producing more output)
  //
  // clean_routing_delta = raw_delta - output_variance_cost
  //   (what we'd save if both flows produced identical output length)
  let cleanRoutingRow = '';
  const llm2Pricing = getPricing(llm2.modelId ?? null);
  const shadowActualCost = shadow?.actualCostUSD ?? null;
  const newFlowTotal     = totals.actualCostUSD   ?? null;
  const shadowOutTok     = shadow?.actualOutputTokens ?? null;
  const newFlowOutTok    = llm2.actualOutputTokens    ?? null;
  if (
    llm2Pricing && shadowActualCost != null && newFlowTotal != null &&
    shadowOutTok != null && newFlowOutTok != null
  ) {
    const rawDelta          = shadowActualCost - newFlowTotal;
    const outVarianceCost   = ((shadowOutTok - newFlowOutTok) / 1_000_000) * llm2Pricing.outUSDPer1M;
    const cleanDelta        = rawDelta - outVarianceCost;
    const cleanDeltaSign    = cleanDelta >= 0 ? '+' : '-';
    const cleanDeltaAbs     = Math.abs(cleanDelta);
    const cleanDeltaPct     = shadowActualCost > 0
      ? ((cleanDelta / shadowActualCost) * 100).toFixed(1) : null;
    const cleanCls  = cleanDelta >= 0 ? 'telemetry-row__value--positive' : 'telemetry-row__value--negative';
    const cleanText = `${cleanDeltaSign}${formatCost(cleanDeltaAbs)}${cleanDeltaPct != null ? ` (${cleanDeltaPct}%)` : ''}`;
    const outVarSign = outVarianceCost >= 0 ? '+' : '-';
    cleanRoutingRow = `
      <div class="telemetry-row">
        <span class="telemetry-row__label">Clean routing delta</span>
        <span class="telemetry-row__value ${cleanCls}">${escTel(cleanText)}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Output variance cost</span>
        <span class="telemetry-row__value telemetry-row__value--muted">${escTel(`${outVarSign}${formatCost(Math.abs(outVarianceCost))}`)}</span>
      </div>`;
  }

  return `
    <div class="telemetry-section">
      <div class="telemetry-section__title">Flow</div>
      <div class="telemetry-row telemetry-row--flow">${escTel(flowPath)}</div>
    </div>

    ${planner ? (() => {
      const routingDecision = (pkg.chosenTools ?? []).join(', ') || '—';
      const routingReason   = planner.finalUsedDecision?.reason ?? '—';
      const fallbackRisk    = planner.finalUsedDecision?.fallback_risk;
      const toolCostMenuIo  = io?.toolCostMenu ?? [];
      const chosenToolName  = pkg.finalTools?.[0] ?? null;

      const toolRows = toolCostMenuIo.map((entry) => {
        const isChosen = entry.type === chosenToolName;
        const tok  = entry.est_tokens  != null ? `${entry.est_tokens} tok` : '— tok';
        const cost = entry.est_cost_usd != null ? `  ($${entry.est_cost_usd.toFixed(5)})` : '';
        const mark = isChosen ? '  ← chosen' : '';
        return `
      <div class="telemetry-row">
        <span class="telemetry-row__label">${escTel(entry.type)}</span>
        <span class="telemetry-row__value${isChosen ? ' telemetry-row__value--positive' : ''}">${escTel(tok + cost + mark)}</span>
      </div>`;
      }).join('');

      const pre  = pkg.preGatherEstTokens ?? null;
      const post = pkg.estTokens ?? 0;
      let ctxTokRow = '';
      if (post > 0) {
        const diff = pre != null ? post - pre : null;
        const pct  = (pre != null && pre > 0) ? ((diff / pre) * 100).toFixed(0) : null;
        const cls  = diff == null ? '' : diff < 0 ? 'telemetry-row__value--positive' : 'telemetry-row__value--negative';
        const diffLabel = diff == null ? '' : ` (${diff > 0 ? '+' : ''}${diff} tok${pct != null ? `, ${pct}%` : ''})`;
        ctxTokRow = `
      <div class="telemetry-row">
        <span class="telemetry-row__label">Context tok (est → actual)</span>
        <span class="telemetry-row__value ${cls}">${escTel(pre != null ? `${pre} → ${post}${diffLabel}` : `${post} tok`)}</span>
      </div>`;
      }

      return `
    <div class="telemetry-section">
      <div class="telemetry-section__title">Routing</div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">LLM1 decision</span>
        <span class="telemetry-row__value">${escTel(routingDecision)}</span>
      </div>
      ${fallbackRisk != null ? `
      <div class="telemetry-row">
        <span class="telemetry-row__label">Fallback risk</span>
        <span class="telemetry-row__value">${escTel(String(fallbackRisk))}</span>
      </div>` : ''}
      ${toolRows}
      ${ctxTokRow}
    </div>`;
    })() : ''}

    <div class="telemetry-section">
      <div class="telemetry-section__title">Cost</div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Old-flow estimate</span>
        <span class="telemetry-row__value">${escTel(formatCost(baseline?.estCostUSD))}</span>
      </div>
      ${shadow?.actualCostUSD != null ? `
      <div class="telemetry-row">
        <span class="telemetry-row__label">Old-flow actual ⚡</span>
        <span class="telemetry-row__value">${escTel(formatCost(shadow.actualCostUSD))}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Old-flow tokens ⚡ (in / out)</span>
        <span class="telemetry-row__value">${escTel(`${shadow.actualInputTokens ?? '—'} / ${shadow.actualOutputTokens ?? '—'}`)}</span>
      </div>` : ''}
      ${planner ? `
      <div class="telemetry-row">
        <span class="telemetry-row__label">LLM1 actual</span>
        <span class="telemetry-row__value">${escTel(formatCost(planner.actualCostUSD))}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">LLM2 actual</span>
        <span class="telemetry-row__value">${escTel(formatCost(llm2.actualCostUSD))}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">LLM2 tokens (in / out)</span>
        <span class="telemetry-row__value">${escTel(`${llm2.actualInputTokens ?? '—'} / ${llm2.actualOutputTokens ?? '—'}`)}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">New-flow total</span>
        <span class="telemetry-row__value">${escTel(formatCost(totals.actualCostUSD))}</span>
      </div>` : `
      <div class="telemetry-row">
        <span class="telemetry-row__label">Actual</span>
        <span class="telemetry-row__value">${escTel(formatCost(totals.actualCostUSD))}</span>
      </div>`}
      <div class="telemetry-row">
        <span class="telemetry-row__label">Δ vs old flow</span>
        <span class="telemetry-row__value ${deltaClass}">${escTel(deltaText)}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">% vs old flow</span>
        <span class="telemetry-row__value ${deltaPctClass}">${escTel(deltaPctText)}</span>
      </div>
      ${outputSizeRow}
      ${cleanRoutingRow}
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
    </div>

    <div class="telemetry-section">
      <div class="telemetry-section__title">Page</div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Title</span>
        <span class="telemetry-row__value">${escTel(summary?.title || summary?.url || '—')}</span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-row__label">Manifest</span>
        <span class="telemetry-row__value">${escTel(summary
          ? `${summary.viewport}, scrollY ${summary.scrollY}, vText ${summary.visibleTextLength}, full ${summary.fullTextLengthEstimate}`
          : '—')}</span>
      </div>
      ${manifestErr ? `
      <div class="telemetry-row">
        <span class="telemetry-row__label">Manifest error</span>
        <span class="telemetry-row__value telemetry-row__value--negative">${escTel(manifestErr)}</span>
      </div>` : ''}
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

    ${io ? `
    <div class="telemetry-section telemetry-section--io">
      <div class="telemetry-section__title">I/O</div>

      ${plannerInputText != null ? `
      <details class="telemetry-io">
        <summary>Planner (LLM1) input</summary>
        <pre class="telemetry-io-content">${escTel(plannerInputText)}</pre>
      </details>` : ''}

      ${planner != null ? `
      <details class="telemetry-io">
        <summary>Planner (LLM1) output</summary>
        <pre class="telemetry-io-content">${escTel(
          planner.rawResponse
            || `[no raw response captured]\nsource: ${planner.source ?? '—'}\nreason: ${planner.finalUsedDecision?.reason ?? '—'}`
        )}</pre>
      </details>` : ''}

      ${routingPanelText != null ? `
      <details class="telemetry-io">
        <summary>Routing: tool selection</summary>
        <pre class="telemetry-io-content">${escTel(routingPanelText)}</pre>
      </details>` : ''}

      ${r1ContextText != null ? `
      <details class="telemetry-io">
        <summary>Context gathered — round 1</summary>
        <pre class="telemetry-io-content">${escTel(r1ContextText)}</pre>
      </details>` : ''}

      ${r1ResponseText != null ? `
      <details class="telemetry-io">
        <summary>LLM2 round 1 response</summary>
        <pre class="telemetry-io-content">${escTel(r1ResponseText)}</pre>
      </details>` : ''}

      ${r2ContextText != null ? `
      <details class="telemetry-io">
        <summary>Context gathered — round 2 (fallback)</summary>
        <pre class="telemetry-io-content">${escTel(r2ContextText)}</pre>
      </details>` : ''}

      ${r2ResponseText != null ? `
      <details class="telemetry-io">
        <summary>LLM2 round 2 response (fallback)</summary>
        <pre class="telemetry-io-content">${escTel(r2ResponseText)}</pre>
      </details>` : ''}

      ${shadow?.outputText != null ? `
      <details class="telemetry-io">
        <summary>Shadow (old flow) input</summary>
        <pre class="telemetry-io-content">User: "${escTel((shadow.inputUserText ?? '').slice(0, 500))}"

[context: viewport_screenshot — old flow always attaches a screenshot]</pre>
      </details>
      <details class="telemetry-io">
        <summary>Shadow (old flow) output</summary>
        <pre class="telemetry-io-content">${escTel(shadow.outputText)}</pre>
      </details>` : ''}
    </div>
    ` : ''}
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

function previewPackageText(pkg, cap = 2000) {
  if (!pkg?.textBlocks?.length) return null;
  return pkg.textBlocks.map((tb) => {
    const content = tb.content ?? '';
    const preview = content.slice(0, cap);
    const over    = content.length > cap;
    return `[${tb.name}${(tb.truncated || over) ? ' — truncated' : ''}]\n${preview}${over ? '\n…' : ''}`;
  }).join('\n\n');
}

function buildFlowPath(record) {
  const io  = record.io      ?? {};
  const pkg = record.package ?? {};
  if (record.flow !== 'planner') {
    const tools = (pkg.finalTools?.length ? pkg.finalTools : pkg.chosenTools ?? []).join(' + ') || 'none';
    return `legacy → ${tools} → LLM2`;
  }
  const plannerDecision = (pkg.chosenTools ?? []).join('') || 'none';
  const plannerSource   = record.planner?.source ?? null;
  // none path: LLM2 was called directly without tool gathering or the
  // structured-output protocol.
  if (plannerDecision === 'none') {
    return 'LLM1 → none → LLM2 direct';
  }
  // context_needed path: orchestrator picked the cheapest tool.
  const r1Types  = (io.r1PackageTypes ?? []).join(' + ') || 'none';
  const r1Action = io.r1Action;
  const prefix   = plannerSource === 'skipped-dom-unreliable' ? 'direct' : 'LLM1';
  let path = `${prefix} → ${plannerDecision} → gather: ${r1Types} → LLM2 r1`;
  if (r1Action === 'provide_answer') {
    path += ' → answer';
  } else if (r1Action === 'request_more_context') {
    const r2Types  = (io.r2PackageTypes ?? []).join(' + ') || 'none';
    const r2Action = io.r2Action;
    path += ` → request_more_context → gather: ${r2Types} → LLM2 r2`;
    path += r2Action === 'provide_answer' ? ' → answer' : ' → degrade';
  } else {
    path += r1Action ? ` → ${r1Action}` : '';
  }
  return path;
}

function buildContextPanelText(types, textPreview, imageCount) {
  const lines = [];
  lines.push(`Types: ${(types ?? []).join(', ') || 'none'}`);
  if (imageCount) lines.push(`Images: ${imageCount} screenshot(s) (base64 not stored)`);
  if (textPreview) { lines.push(''); lines.push(textPreview); }
  return lines.join('\n');
}

function buildResponsePanelText(action, rawResponse, requestedTypes, requestReason) {
  const lines = [];
  lines.push(`Action: ${action ?? '—'}`);
  if (requestedTypes?.length) lines.push(`Requested: ${requestedTypes.join(', ')}`);
  if (requestReason)          lines.push(`Reason: ${requestReason}`);
  if (rawResponse != null) {
    lines.push('');
    lines.push(String(rawResponse).slice(0, 3000));
    if (String(rawResponse).length > 3000) lines.push('…');
  }
  return lines.join('\n');
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
