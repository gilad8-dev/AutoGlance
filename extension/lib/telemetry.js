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

import { getPricing, costFromUsage } from './cost-estimator.js';

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
    const isGroup = ['planner', 'package', 'llm2', 'oldFlowBaseline', 'shadowOldFlow', 'totals'].includes(key);
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
  const shadow   = record.shadowOldFlow   ?? {};

  const plannerActual = planner.actualCostUSD ?? 0;
  const llm2Actual    = llm2.actualCostUSD    ?? 0;
  const actualCost = (plannerActual + llm2Actual) || null;

  const plannerEst = planner.estCostUSD ?? 0;
  const llm2Est    = llm2.estCostUSD    ?? 0;
  const estCost = (plannerEst + llm2Est) || null;

  // Use shadow actual when available (real old-flow call ran); fall back to estimate.
  const baselineCost = shadow.actualCostUSD ?? baseline.estCostUSD ?? null;

  record.totals = {
    actualCostUSD: actualCost,
    estCostUSD:    estCost,
    latencyMs:     record.endedAt ? record.endedAt - record.startedAt : null,
    deltaVsOldFlow: (baselineCost != null && actualCost != null)
      ? baselineCost - actualCost
      : null,
    deltaVsOldFlowPercent: (baselineCost != null && baselineCost > 0 && actualCost != null)
      ? ((baselineCost - actualCost) / baselineCost) * 100
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
    // Strip large / in-memory-only fields before persisting. `io` contains raw
    // LLM response text (potentially KBs) — the chip uses the in-memory record
    // for display, so stripping it here keeps the ring buffer compact.
    const { _finalized, io: _io, ...persistable } = record;
    buf.push(persistable);
    while (buf.length > RING_BUFFER_MAX) buf.shift();
    chrome.storage.local.set({ [RING_BUFFER_KEY]: buf }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[AutoGlance] telemetry ring buffer persist failed:', chrome.runtime.lastError.message);
      }
    });
  });
}

export { costFromUsage };
