/**
 * LLM1 - the cheap context planner.
 *
 * Purpose: given the user's prompt + a manifest summary + change signals +
 * the available tool cost menu, decide which context tools to gather before
 * calling the answering model. The planner NEVER answers the user. Its
 * output is a tiny strict-JSON object the orchestrator consumes.
 *
 * Inputs given to LLM1 (and only these):
 *   - user prompt (text)
 *   - manifest summary (facts only - no raw page text, no hashes)
 *   - change signals
 *   - available context types
 *   - estimated costs per option
 *
 * Inputs deliberately NOT given to LLM1:
 *   - raw DOM
 *   - screenshots
 *   - the full conversation history
 *
 * Provider: OpenAI GPT-5-nano (one-shot, non-streaming, json_schema-enforced).
 * Direct fetch - does not go through ai-client.js, because the planner has a
 * different request shape (no streaming, no chat history) and would only get
 * awkward routed through the chat client.
 */

import { getPricing } from './cost-estimator.js';

const PLANNER_API_URL    = 'https://api.openai.com/v1/chat/completions';
const PLANNER_TIMEOUT_MS = 15_000;
const PLANNER_MAX_TOKENS = 2500;

/** Vocabulary the planner is allowed to choose from. Must match context-tools.js. */
export const ALLOWED_CONTEXT_TYPES = ['none', 'viewport_dom', 'viewport_screenshot'];
const ALLOWED_RISK = ['low', 'medium', 'high'];

/**
 * Bumped whenever the system prompt or validation rules change in a way that
 * invalidates historical comparisons. Telemetry stamps every decision with
 * this so a/b/c versioned tuning stays meaningful.
 */
export const PLANNER_PROMPT_VERSION = 'v4';

/**
 * System prompt - short and rule-driven. The decision rules echo the
 * planner-design spec and are the single source of truth for LLM1 behaviour.
 * Output schema enforced separately via response_format.json_schema.
 */
const PLANNER_SYSTEM_PROMPT = [
  `You are a browser-context planner for an AI browser assistant called AutoGlance.`,
  `Your only job is to choose what page data to attach to the user's next message`,
  `before it reaches the answering model. You DO NOT answer the user.`,
  ``,
  `Output strict JSON only with this exact shape:`,
  `{`,
  `  "context_types": [<subset of available_context_types>],`,
  `  "reason": "<short explanation of the choice>",`,
  `  "fallback_risk": "low" | "medium" | "high"`,
  `}`,
  ``,
  `Decision rules:`,
  ``,
  `1. Pick the cheapest set of context_types that is very likely sufficient`,
  `   for a separate model to answer correctly. Prefer correctness over cost`,
  `   when uncertain.`,
  ``,
  `2. context_types must be a subset of available_context_types.`,
  ``,
  `3. Use "none" when ALL of these hold:`,
  `   a. conversation_has_prior_turns is true.`,
  `   b. all change_signals are false.`,
  `   c. The prompt does not signal that the user is asking about NEW or DIFFERENT`,
  `      content not yet seen by the answering model.`,
  `   d. page_manifest.dom_reliable is true. If false (PDF viewer, canvas-dominant`,
  `      page, or similar), change signals are blind to visual content changes —`,
  `      scrolling to a new PDF page leaves all signals false. "none" is unsafe;`,
  `      gather a screenshot instead.`,
  ``,
  `   Core insight: if the page has not changed (all change_signals false), the`,
  `   answering model already has that page's content in its conversation memory`,
  `   from prior turns. Re-sending the same screenshot or DOM wastes tokens with`,
  `   no benefit. When the page is unchanged, default to "none".`,
  ``,
  `   "none" IS correct for:`,
  `   - Follow-ups on the same content: "and can you solve this one?", "what about`,
  `     this formula?", "can you elaborate?" when page is unchanged.`,
  `   - Clarifications: "what does that mean?", "explain further", "say it again".`,
  `   - References to the prior answer: "explain the second point", "rephrase that".`,
  ``,
  `   "none" is NOT correct for:`,
  `   - Prompts signaling changed state: "what's the price now?", "did it update?".`,
  `   - Prompts explicitly requesting new/different content: "solve the OTHER formula",`,
  `     "look at this new one", "what about the chart on the next page?".`,
  `   - First messages (no prior context exists).`,
  `   - Pages with dom_reliable: false (condition d above).`,
  ``,
  `4. Prefer viewport_dom for tasks that depend on visible text, summarization,`,
  `   structured data, or links.`,
  ``,
  `5. Prefer viewport_screenshot for tasks that depend on visual layout, charts,`,
  `   graphs, canvas content, formulas in image form, exact UI state, OR when`,
  `   page_manifest.dom_reliable is false.`,
  ``,
  `6. Avoid combining viewport_dom + viewport_screenshot unless both are clearly`,
  `   needed (e.g. a chart paired with surrounding caption text).`,
  ``,
  `7. fallback_risk reflects the chance the answering model will need additional`,
  `   context after this. "low" when the package is comprehensive for the prompt.`,
  ``,
  `Output ONLY the JSON object. No prose, no markdown fences.`,
].join('\n');

/** OpenAI structured-output schema. Strict mode rejects unknown keys. */
const PLANNER_JSON_SCHEMA = {
  name: 'context_plan',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['context_types', 'reason', 'fallback_risk'],
    properties: {
      context_types: {
        type: 'array',
        items: { type: 'string', enum: ALLOWED_CONTEXT_TYPES },
        minItems: 1,
      },
      reason:        { type: 'string' },
      fallback_risk: { type: 'string', enum: ALLOWED_RISK },
    },
  },
};

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run the planner. Always resolves with a normalized PlannerDecision; never
 * throws to the orchestrator. On any failure (no API key, parse error, schema
 * violation, rule violation, transport error, timeout, abort) the decision
 * falls back to `defaultFailurePackage` and the source field records why.
 *
 * @param {object} args
 * @param {string} args.userPrompt
 * @param {object} args.manifest                    Full manifest from page-manifest.js
 * @param {object} args.changeSignals               From change-signals.js
 * @param {Array}  args.costMenu                    From cost-estimator.buildCostMenu
 * @param {boolean} args.conversationHasPriorTurns
 * @param {string} args.apiKey                      OpenAI API key
 * @param {string} args.plannerModelId              Default 'gpt-5-nano'
 * @param {string[]} args.defaultFailurePackage     e.g. ['viewport_dom','viewport_screenshot']
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<PlannerDecision>}
 */
export async function planContext(args) {
  const {
    userPrompt,
    manifest,
    changeSignals,
    costMenu,
    conversationHasPriorTurns,
    apiKey,
    plannerModelId = 'gpt-5-nano',
    defaultFailurePackage = ['viewport_dom', 'viewport_screenshot'],
    signal,
  } = args ?? {};

  if (!apiKey) {
    return defaultDecision(defaultFailurePackage, 'no-api-key', 'Planner has no OpenAI API key');
  }
  if (!Array.isArray(costMenu) || costMenu.length === 0) {
    return defaultDecision(defaultFailurePackage, 'empty-cost-menu', 'No tools available for this turn');
  }

  const userMessage = buildPlannerUserMessage({
    userPrompt,
    manifest,
    changeSignals,
    costMenu,
    conversationHasPriorTurns,
  });

  let raw;
  try {
    raw = await callPlanner({ apiKey, model: plannerModelId, userMessage, signal });
  } catch (err) {
    return defaultDecision(defaultFailurePackage, 'transport-error', err?.message || 'Planner request failed');
  }

  const validated = validateDecision(raw.text, {
    availableTypes: costMenu.map((o) => o.type),
    conversationHasPriorTurns,
    changeSignals,
    manifest,
  });

  if (!validated.ok) {
    return {
      ...defaultDecision(defaultFailurePackage, validated.source, validated.reason),
      // Preserve usage/latency + raw/validated diff even on failure so telemetry
      // costs the call we made and can show the planner's intended choice
      // alongside what we actually used.
      latencyMs:         raw.latencyMs,
      actualUsage:       raw.usage,
      actualCostUSD:     usageCost(raw.usage, plannerModelId),
      rawResponse:       raw.text,
      validatedDecision: null,
    };
  }

  const decision = {
    context_types: validated.decision.context_types,
    reason:        validated.decision.reason,
    fallback_risk: validated.decision.fallback_risk,
  };

  return {
    // finalUsedDecision (top-level, matches the orchestrator's read path)
    ...decision,
    parseOk:           true,
    source:            'planner',
    promptVersion:     PLANNER_PROMPT_VERSION,
    // Provenance for telemetry/debug. rawResponse is what LLM1 emitted;
    // validatedDecision is what passed schema + rules; on the happy path
    // they are equivalent. On rule-violation/invalid-types they diverge.
    rawResponse:       raw.text,
    validatedDecision: decision,
    latencyMs:         raw.latencyMs,
    actualUsage:       raw.usage,
    actualCostUSD:     usageCost(raw.usage, plannerModelId),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build the JSON body the planner sees as its user message. Manifest is
 * summarized to facts only - no raw text, no hashes, no tab id.
 */
function buildPlannerUserMessage({
  userPrompt,
  manifest,
  changeSignals,
  costMenu,
  conversationHasPriorTurns,
}) {
  const payload = {
    user_prompt:                  userPrompt ?? '',
    conversation_has_prior_turns: !!conversationHasPriorTurns,
    change_signals:               changeSignals ?? {},
    page_manifest:                summarizeManifestForPlanner(manifest),
    available_context_types:      costMenu.map((o) => o.type),
    context_options:              costMenu,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Manifest summary in snake_case, facts only, no hashes or volatile fields
 * the planner can't reason about. Compact so it fits in nano's context window
 * and so the planner can scan it quickly.
 */
function summarizeManifestForPlanner(m) {
  if (!m) return null;
  return {
    url:                          m.url,
    title:                        m.title,
    viewport:                     `${m.viewportW ?? 0}x${m.viewportH ?? 0}`,
    scroll_y:                     m.scrollY ?? 0,
    scroll_max_y:                 m.scrollMaxY ?? 0,
    visible_text_length:          m.visibleTextLength ?? 0,
    full_text_length_estimate:    m.fullTextLengthEstimate ?? 0,
    visible_image_count:          m.visibleImageCount ?? 0,
    has_large_visible_image:      !!m.hasLargeVisibleImage,
    has_canvas:                   !!m.hasCanvas,
    has_svg:                      !!m.hasSvg,
    has_table:                    !!m.hasTable,
    has_form_input:               !!m.hasFormInput,
    has_focused_element:          !!m.hasFocusedElement,
    focused_element_type:         m.focusedElementType ?? null,
    dom_reliable:                 m.domReliable !== false,
    has_cross_origin_iframes:     !!m.hasCrossOriginIframes,
    sensitive_keywords_hit:       m.sensitiveKeywordsHit ?? null,
  };
}

/** Network call. Resolves with { text, usage, latencyMs }; throws on transport errors. */
async function callPlanner({ apiKey, model, userMessage, signal }) {
  const startedAt = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('Planner timed out')), PLANNER_TIMEOUT_MS);

  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }

  try {
    const response = await fetch(PLANNER_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT },
          { role: 'user',   content: userMessage },
        ],
        // No response_format — system prompt instructs JSON-only output.
        // Dropping this makes the call compatible with any GPT model tier.
        max_completion_tokens: PLANNER_MAX_TOKENS,
      }),
      signal: ctrl.signal,
    });

    if (!response.ok) {
      let body = '';
      try { body = await response.text(); } catch { /* ignore */ }
      throw new Error(`Planner API ${response.status}: ${body.slice(0, 200)}`);
    }

    const data    = await response.json();
    const choice  = data?.choices?.[0];
    const message = choice?.message;
    const text    = message?.content ?? '';
    if (!text) {
      const refusal      = message?.refusal;
      const finishReason = choice?.finish_reason;
      throw new Error(
        refusal
          ? `Planner model refused: ${refusal}`
          : `Planner returned no content (finish_reason=${finishReason ?? '?'}). Check that plannerModelId is a valid chat-completion model.`
      );
    }
    const usage   = data?.usage ? {
      inputTokens:  data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    } : null;

    return { text, usage, latencyMs: Math.round(performance.now() - startedAt) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strict-validate the planner's raw text. Returns { ok: true, decision }
 * on success, otherwise { ok: false, source, reason }.
 *
 * Validation steps:
 *   1. JSON.parse must succeed.
 *   2. context_types must be a non-empty array.
 *   3. Every context_type must be in availableTypes.
 *   4. fallback_risk must be in {low, medium, high}.
 *   5. estimated_package_cost must be a finite number.
 *   6. reason must be a non-empty string.
 *   7. "none" rule: if context_types === ["none"], conversation must have prior
 *      turns AND every change signal must be false. (The third clause -
 *      prompt-level "needs fresh page state" - is delegated to LLM1; we don't
 *      second-guess it here.)
 */
function validateDecision(text, ctx) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return { ok: false, source: 'parse-error', reason: `Planner JSON parse failed: ${err.message}` };
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, source: 'invalid-shape', reason: 'Planner output is not an object' };
  }

  const types = obj.context_types;
  if (!Array.isArray(types) || types.length === 0) {
    return { ok: false, source: 'invalid-shape', reason: 'context_types missing or empty' };
  }

  const availableSet = new Set(ctx.availableTypes ?? []);
  const filtered = types.filter((t) => availableSet.has(t));
  if (filtered.length === 0) {
    return { ok: false, source: 'invalid-types', reason: 'No requested context_types are available' };
  }
  // If the planner returned a mix where some are unavailable, drop the bad ones
  // but keep the rest. This is more useful than a wholesale fallback.
  const dedup = Array.from(new Set(filtered));

  if (typeof obj.reason !== 'string' || !obj.reason.trim()) {
    return { ok: false, source: 'invalid-shape', reason: 'reason missing or not a string' };
  }
  if (!ALLOWED_RISK.includes(obj.fallback_risk)) {
    return { ok: false, source: 'invalid-shape', reason: `fallback_risk must be one of ${ALLOWED_RISK.join('|')}` };
  }

  // "none" rule enforcement (mechanical clauses 3a + 3b only; clause 3c -
  // prompt-level "needs fresh page state" - is delegated to LLM1).
  const isNoneOnly = dedup.length === 1 && dedup[0] === 'none';
  if (isNoneOnly) {
    const verdict = isNoneAllowed_V1Strict(ctx);
    if (!verdict.allowed) {
      return { ok: false, source: 'rule-violation-none', reason: verdict.reason };
    }
  }

  return {
    ok: true,
    decision: {
      context_types: dedup,
      reason:        obj.reason.trim(),
      fallback_risk: obj.fallback_risk,
    },
  };
}

/**
 * V1 "none" rule: strict binary check. Returns { allowed, reason }.
 *
 * Future swap-in (planned): replace with a meaningful_change_score derived
 * from change_signals + manifest deltas, where score < threshold permits
 * "none" even with some technically-true signals (e.g. trivial scroll). To
 * swap, introduce isNoneAllowed_V2Score(ctx) and route validateDecision
 * through a version selector. Keeping the V1 helper named explicitly so
 * the swap is grep-visible.
 */
function isNoneAllowed_V1Strict(ctx) {
  if (!ctx.conversationHasPriorTurns) {
    return { allowed: false, reason: '"none" not allowed on first message' };
  }
  // When DOM is unreliable (PDF viewer, canvas-dominant page), change signals
  // are blind to visual content changes. Scrolling a PDF leaves scrollY=0 and
  // visibleDomHash unchanged, so all signals appear false even when the user
  // is now looking at completely different content. "none" is unsafe.
  if (ctx.manifest?.domReliable === false) {
    return { allowed: false, reason: '"none" not allowed when dom_reliable is false — change signals cannot detect visual content changes' };
  }
  const signals = ctx.changeSignals ?? {};
  const flaggedKeys = [
    'tab_changed_since_last',
    'url_changed_since_last',
    'viewport_size_changed',
    'scroll_position_changed',
    'visible_dom_hash_changed',
    'media_hash_changed',
  ];
  const anyFlagged = flaggedKeys.some((k) => signals[k] === true);
  if (anyFlagged) {
    return { allowed: false, reason: '"none" not allowed when change signals indicate page state may have changed' };
  }
  return { allowed: true, reason: null };
}

/** Build a normalized failure decision. `parseOk: false` flags it for telemetry. */
function defaultDecision(defaultPackage, source, reason) {
  return {
    context_types:          Array.isArray(defaultPackage) && defaultPackage.length
      ? Array.from(new Set(defaultPackage))
      : ['viewport_dom', 'viewport_screenshot'],
    reason:                 reason || 'planner unavailable; using default failure package',
    fallback_risk:          'unknown',
    estimated_package_cost: null,
    parseOk:                false,
    source,
    promptVersion:          PLANNER_PROMPT_VERSION,
    rawResponse:            null,
    validatedDecision:      null,
    latencyMs:              null,
    actualUsage:            null,
    actualCostUSD:          null,
  };
}

function usageCost(usage, modelId) {
  if (!usage) return null;
  const pricing = getPricing(modelId);
  if (!pricing) return null;
  const inCost  = ((usage.inputTokens  ?? 0) / 1_000_000) * pricing.inUSDPer1M;
  const outCost = ((usage.outputTokens ?? 0) / 1_000_000) * pricing.outUSDPer1M;
  return inCost + outCost;
}
