/**
 * Cost estimator - turns a manifest + model id into estimated token counts
 * and USD costs for each context tool. Drives both the planner's cost menu
 * (LLM1 input) and the old-flow baseline shown in the telemetry chip.
 *
 * MVP scope: Anthropic pricing only. Other providers return null cost (still
 * return token counts) until Stage E adds their tables. Estimator is allowed
 * to be wrong by ±25% for routing purposes; telemetry compares estimated vs
 * actual on every turn so we calibrate from real data.
 *
 * Pricing is hard-coded by design - no live fetch. Update the PRICING table
 * when published rates change.
 */

import { getModelById } from './storage.js';

/**
 * USD per 1M tokens, by model id. Anthropic only in MVP - extend in Stage E.
 * Numbers reflect Anthropic's published pricing tiers; verify before relying
 * on absolute amounts. Routing decisions only need the relative ordering.
 */
export const PRICING = {
  'claude-opus-4-7':   { inUSDPer1M: 15,   outUSDPer1M: 75   },
  'claude-sonnet-4-6': { inUSDPer1M:  3,   outUSDPer1M: 15   },
  'claude-opus-4-6':   { inUSDPer1M: 15,   outUSDPer1M: 75   },
  'claude-haiku-4-5':  { inUSDPer1M:  1,   outUSDPer1M:  5   },
  // Planner (LLM1) - placeholder rates; verify against current OpenAI pricing.
  // Numbers are tiny on purpose for nano-tier; telemetry will surface drift.
  'gpt-5-nano-2025-08-07': { inUSDPer1M: 0.05, outUSDPer1M: 0.40 },
};

/**
 * Image-token formulas by provider. Anthropic uses an area-based formula;
 * OpenAI is tile-based (placeholder until Stage E); Gemini Flash is roughly
 * flat per image. The model's provider is looked up from the registry.
 */
const IMAGE_TOKENS_BY_PROVIDER = {
  anthropic: (w, h) => Math.ceil(((w || 0) * (h || 0)) / 750),
  openai:    (_w, _h) => 765,   // rough high-detail placeholder
  gemini:    (_w, _h) => 258,   // Flash flat rate placeholder
};

const TOOL_OUTPUT_CAPS = {
  viewport_dom:             6000,    // chars of sanitized output
  full_page_dom:            40000,
};

const DOM_TAG_OVERHEAD = 1.4;        // sanitized DOM is ~1.4x raw text chars

const CHARS_PER_TOKEN = 4;           // standard rough estimate

/** Pricing record for a given LLM2 model, or null if not in the table. */
export function getPricing(modelId) {
  return PRICING[modelId] ?? null;
}

/** Cheap rough text-token estimate. Anchored to the chars-per-token rule. */
export function estimateTextTokens(charCount) {
  if (!charCount || charCount < 0) return 0;
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

/**
 * Image-token estimate for a given model id and pixel dimensions.
 * Falls back to the Anthropic formula for unknown providers.
 */
export function estimateImageTokens(modelId, width, height) {
  const provider = getModelById(modelId)?.provider ?? 'anthropic';
  const fn = IMAGE_TOKENS_BY_PROVIDER[provider] ?? IMAGE_TOKENS_BY_PROVIDER.anthropic;
  return fn(width, height);
}

/** USD cost of `tokens` tokens at a given per-million rate. */
function tokenCost(tokens, perMillionUsd) {
  return (tokens / 1_000_000) * perMillionUsd;
}

/**
 * Estimate the input-token footprint of a single context tool given the
 * manifest. Returns 0 for tools whose footprint can't yet be predicted.
 */
export function estimateToolInputTokens(toolType, manifest, llm2Model) {
  if (!manifest) return 0;

  switch (toolType) {
    case 'none':
      return 0;

    case 'viewport_dom': {
      const cappedChars = Math.min(
        (manifest.visibleTextLength ?? 0) * DOM_TAG_OVERHEAD,
        TOOL_OUTPUT_CAPS.viewport_dom
      );
      return estimateTextTokens(cappedChars);
    }

    case 'full_page_dom': {
      const cappedChars = Math.min(
        (manifest.fullTextLengthEstimate ?? 0) * DOM_TAG_OVERHEAD,
        TOOL_OUTPUT_CAPS.full_page_dom
      );
      return estimateTextTokens(cappedChars);
    }

    case 'viewport_screenshot':
      return estimateImageTokens(llm2Model, manifest.viewportW, manifest.viewportH);

    case 'element_crop':
      // Rough placeholder until Stage B picks an actual element bbox.
      return estimateImageTokens(
        llm2Model,
        Math.round((manifest.viewportW || 0) / 2),
        Math.round((manifest.viewportH || 0) / 2)
      );

    case 'focused_element_context':
      return 200;

    default:
      return 0;
  }
}

/**
 * Estimate the total input cost of a chosen package of context tools.
 * `estCostUSD` is null when the model isn't in PRICING (e.g., non-Anthropic).
 */
export function estimatePackageCost(types, manifest, llm2Model) {
  const breakdown = {};
  let estTokens = 0;
  for (const t of types ?? []) {
    const tokens = estimateToolInputTokens(t, manifest, llm2Model);
    breakdown[t] = tokens;
    estTokens += tokens;
  }
  const pricing = getPricing(llm2Model);
  const estCostUSD = pricing ? tokenCost(estTokens, pricing.inUSDPer1M) : null;
  return { estTokens, estCostUSD, breakdown };
}

/**
 * Build the cost menu the planner sees. One entry per available tool with
 * estimated input tokens and cost. Cost is null for non-priced models;
 * the planner should still rank by est_tokens in that case.
 */
export function buildCostMenu(availableTypes, manifest, llm2Model) {
  const pricing = getPricing(llm2Model);
  return availableTypes.map((type) => {
    const tokens = estimateToolInputTokens(type, manifest, llm2Model);
    const cost = pricing ? tokenCost(tokens, pricing.inUSDPer1M) : null;
    return { type, est_tokens: tokens, est_cost_usd: cost };
  });
}

/**
 * Estimate what the existing screenshot-only flow (today's behavior) would
 * cost for this turn. Used to render the "saved $X" delta in the telemetry
 * chip. Includes input (system prompt + history + user text + viewport image)
 * and a placeholder output budget.
 *
 * @param {object} args
 * @param {object} args.manifest               Current page manifest.
 * @param {string} args.llm2Model              The user's selected LLM2 model id.
 * @param {string} args.userPromptText         Current user message text.
 * @param {number} [args.systemPromptChars]    Chars in the system prompt.
 * @param {number} [args.historyChars]         Total chars across prior text turns.
 * @param {number} [args.expectedOutputTokens] Output budget assumption (default 400).
 */
export function estimateOldFlowBaseline({
  manifest,
  llm2Model,
  userPromptText,
  systemPromptChars = 0,
  historyChars = 0,
  expectedOutputTokens = 400,
}) {
  const inputTextChars = systemPromptChars + historyChars + (userPromptText?.length ?? 0);
  const inputTextTokens = estimateTextTokens(inputTextChars);
  const imageTokens = manifest
    ? estimateImageTokens(llm2Model, manifest.viewportW, manifest.viewportH)
    : 0;
  const inputTokens = inputTextTokens + imageTokens;
  const outputTokens = expectedOutputTokens;

  const pricing = getPricing(llm2Model);
  const inputCost  = pricing ? tokenCost(inputTokens,  pricing.inUSDPer1M)  : null;
  const outputCost = pricing ? tokenCost(outputTokens, pricing.outUSDPer1M) : null;
  const totalCost  = (inputCost != null && outputCost != null) ? inputCost + outputCost : null;

  return {
    estInputTokens:  inputTokens,
    estOutputTokens: outputTokens,
    estTokens:       inputTokens + outputTokens,
    estInputCostUSD:  inputCost,
    estOutputCostUSD: outputCost,
    estCostUSD:       totalCost,
    breakdown: {
      systemPromptTokens: estimateTextTokens(systemPromptChars),
      historyTokens:      estimateTextTokens(historyChars),
      userPromptTokens:   estimateTextTokens(userPromptText?.length ?? 0),
      imageTokens,
    },
  };
}
