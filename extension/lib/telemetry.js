/**
 * Per-turn telemetry. Captures planner decisions, package contents, actual
 * vs estimated token counts/costs, and latency for each assistant turn.
 *
 * Two storage layers:
 *   - in-memory map keyed by turnId for instant chip/drawer access this session
 *   - chrome.storage.local ring buffer (last 50 records) for cross-session
 *     inspection. Local, never sync, never sent anywhere.
 *
 * Lifecycle:
 *   const turnId = startTurn({ llm2Provider, llm2Model, ... });
 *   update(turnId, { oldFlowBaseline });
 *   update(turnId, { llm2: { actualInputTokens, ... } });
 *   const record = finalize(turnId);    // also persists to ring buffer
 *
 * The record shape grows over the turn - any field can be omitted when the
 * corresponding flow didn't run (e.g. planner.* is absent on existing-flow
 * turns until Step 6 lands).
 */

import { getPricing } from './cost-estimator.js';

const RING_BUFFER_KEY = 'autoglanceTelemetry';
const RING_BUFFER_MAX = 50;

const inMemory = new Map();   // turnId -> record
let nextTurnId = 0;

/**
 * Start a new turn record. `seed` may include any top-level fields known up
 * front (provider/model identifiers, manifest summary, change signals).
 */
export function startTurn(seed = {}) {
  nextTurnId += 1;
  const turnId = `t${nextTurnId}`;
  const record = {
    turnId,
    startedAt: Date.now(),
    ...seed,
  };
  inMemory.set(turnId, record);
  return turnId;
}

/**
 * Shallow-merge a patch into the in-memory record. Nested objects under known
 * group keys (planner / package / llm2 / oldFlowBaseline / totals) are merged
 * one level deep so callers can patch incrementally without clobbering siblings.
 */
export function update(turnId, patch) {
  const record = inMemory.get(turnId);
  if (!record || !patch) return;

  for (const key of Object.keys(patch)) {
    const incoming = patch[key];
    const isNestedObject = incoming && typeof incoming === 'object' && !Array.isArray(incoming);
    const isGroup = ['planner', 'package', 'llm2', 'oldFlowBaseline', 'totals'].includes(key);
    if (isNestedObject && isGroup) {
      record[key] = { ...(record[key] ?? {}), ...incoming };
    } else {
      record[key] = incoming;
    }
  }
}

/**
 * Compute totals, persist to the ring buffer, and return the finalized record.
 * Safe to call once per turn. Subsequent calls return null.
 */
export function finalize(turnId) {
  const record = inMemory.get(turnId);
  if (!record) return null;
  if (record._finalized) return record;

  const planner  = record.planner  ?? {};
  const llm2     = record.llm2     ?? {};
  const baseline = record.oldFlowBaseline ?? {};

  const plannerActual = planner.actualCostUSD ?? 0;
  const llm2Actual    = llm2.actualCostUSD    ?? 0;
  const actualCost = (plannerActual + llm2Actual) || null;

  const plannerEst = planner.estCostUSD ?? 0;
  const llm2Est    = llm2.estCostUSD    ?? 0;
  const estCost = (plannerEst + llm2Est) || null;

  const baselineCost = baseline.estCostUSD ?? null;

  record.totals = {
    actualCostUSD: actualCost,
    estCostUSD:    estCost,
    latencyMs:     record.endedAt ? record.endedAt - record.startedAt : null,
    deltaVsOldFlow: (baselineCost != null && actualCost != null)
      ? baselineCost - actualCost
      : null,
    deltaVsEstPercent: (estCost != null && actualCost != null && estCost > 0)
      ? ((actualCost - estCost) / estCost) * 100
      : null,
  };

  record._finalized = true;
  pushToRingBuffer(record);
  return record;
}

/** Mark the turn end-time. Call before finalize() to compute total latency. */
export function markEnd(turnId) {
  const record = inMemory.get(turnId);
  if (record) record.endedAt = Date.now();
}

export function get(turnId) {
  return inMemory.get(turnId) ?? null;
}

/** Read the persisted ring buffer (last N entries, most recent last). */
export async function recent(n = RING_BUFFER_MAX) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [RING_BUFFER_KEY]: [] }, (result) => {
      const buf = result[RING_BUFFER_KEY] ?? [];
      resolve(buf.slice(-n));
    });
  });
}

/** Erase the ring buffer. Useful for dev resets. */
export async function clearAll() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(RING_BUFFER_KEY, () => resolve());
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pushToRingBuffer(record) {
  chrome.storage.local.get({ [RING_BUFFER_KEY]: [] }, (result) => {
    const buf = result[RING_BUFFER_KEY] ?? [];
    // Strip the in-memory _finalized marker before persisting
    const { _finalized, ...persistable } = record;
    buf.push(persistable);
    while (buf.length > RING_BUFFER_MAX) buf.shift();
    chrome.storage.local.set({ [RING_BUFFER_KEY]: buf });
  });
}

/**
 * Convenience: convert a usage report ({inputTokens, outputTokens}) plus a
 * model id into a cost number. Returns null when the model is unpriced.
 */
export function costFromUsage(usage, modelId) {
  if (!usage) return null;
  const pricing = getPricing(modelId);
  if (!pricing) return null;
  const inCost  = ((usage.inputTokens  ?? 0) / 1_000_000) * pricing.inUSDPer1M;
  const outCost = ((usage.outputTokens ?? 0) / 1_000_000) * pricing.outUSDPer1M;
  return inCost + outCost;
}
