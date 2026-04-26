/**
 * Change-signal tracker - the lightweight history substitute the planner uses
 * to decide whether prior browser context may already be in the conversation.
 *
 * The tracker stores recent manifests per tab and the cross-tab pointer of the
 * previous turn. From two manifests it produces a small boolean record the
 * planner consumes alongside the current manifest.
 *
 * State lives entirely in side-panel runtime memory (no persistence). When the
 * user clears the conversation, the orchestrator should call reset().
 *
 * Signal semantics:
 *   is_first_message            no prior turn this session (caller-supplied).
 *   tab_changed_since_last      previous turn was on a different tab.
 *   url_changed_since_last      same tab, different URL than last turn there.
 *   viewport_size_changed       same tab, viewport dimensions differ.
 *   scroll_position_changed     same tab, |Δ scrollY| exceeds the threshold.
 *   visible_dom_hash_changed    same tab, the visible-text fingerprint changed.
 *   media_hash_changed          same tab, the visible-media fingerprint changed.
 *   ms_since_last_turn          time since the previous turn, or null.
 */

const SCROLL_DELTA_THRESHOLD_PX = 50;

export function createChangeSignalTracker() {
  const byTab = new Map();        // tabId -> last manifest seen on that tab
  let lastTurnTabId = null;       // tabId of the previous turn (any tab)
  let lastTurnTimestamp = null;   // ms epoch of the previous turn

  function compute(currentManifest, conversationHasPriorTurns) {
    const tabId = currentManifest?.tabId ?? null;
    const prev = tabId !== null ? byTab.get(tabId) ?? null : null;

    const tabChanged = lastTurnTabId !== null && lastTurnTabId !== tabId;

    return {
      is_first_message:         !conversationHasPriorTurns,
      tab_changed_since_last:   tabChanged,
      url_changed_since_last:   !!prev && prev.url !== currentManifest.url,
      viewport_size_changed:    !!prev && (
        prev.viewportW !== currentManifest.viewportW ||
        prev.viewportH !== currentManifest.viewportH
      ),
      scroll_position_changed:  !!prev && Math.abs(
        (prev.scrollY ?? 0) - (currentManifest.scrollY ?? 0)
      ) > SCROLL_DELTA_THRESHOLD_PX,
      visible_dom_hash_changed: !!prev && prev.visibleDomHash !== currentManifest.visibleDomHash,
      media_hash_changed:       !!prev && prev.mediaHash      !== currentManifest.mediaHash,
      ms_since_last_turn:       lastTurnTimestamp !== null
        ? Math.max(0, (currentManifest.timestamp ?? Date.now()) - lastTurnTimestamp)
        : null,
    };
  }

  function record(currentManifest) {
    if (!currentManifest) return;
    const tabId = currentManifest.tabId ?? null;
    if (tabId !== null) byTab.set(tabId, currentManifest);
    lastTurnTabId = tabId;
    lastTurnTimestamp = currentManifest.timestamp ?? Date.now();
  }

  function reset() {
    byTab.clear();
    lastTurnTabId = null;
    lastTurnTimestamp = null;
  }

  function getLastForTab(tabId) {
    return byTab.get(tabId) ?? null;
  }

  return { compute, record, reset, getLastForTab };
}
