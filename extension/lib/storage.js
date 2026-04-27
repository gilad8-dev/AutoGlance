/**
 * Chrome storage wrapper with typed defaults.
 * All settings live in chrome.storage.sync so they roam with the user's Chrome profile.
 */

/**
 * Single source of truth for every supported model across providers.
 *
 * Entry shape:
 *   { id, displayName, provider, family, status?, capabilities? }
 *
 * Field semantics:
 *   id          - The exact identifier sent to the provider's API. Treated as
 *                 an opaque string; never validated against a hardcoded list.
 *   displayName - The human-readable label rendered in dropdowns. Preserved
 *                 verbatim from configuration - never auto-generated.
 *   provider    - Routing key. One of 'anthropic' | 'openai' | 'gemini'.
 *   family      - Free-form grouping label (e.g. 'claude-4', 'gemini-3').
 *   status      - Optional. 'stable' (default), 'preview', or 'label-only'.
 *                 'label-only' marks entries supplied as display labels whose
 *                 exact API id has not been verified - the API call may fail
 *                 until the id is updated. UI may render a hint for these.
 *   capabilities - Optional informational tags ('vision', 'streaming',
 *                  'reasoning'). No code path gates behavior on these.
 *
 * No code path anywhere in the extension special-cases a specific id or
 * family - everything model-related flows through this registry.
 */
export const MODELS = [
  // ── Anthropic - newest first ──
  { id: 'claude-opus-4-7',   displayName: 'Opus 4.7 (Most capable for complex coding)',  provider: 'anthropic', family: 'claude-4', capabilities: ['vision', 'streaming'] },
  { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6 (Recommended for most tasks)',     provider: 'anthropic', family: 'claude-4', capabilities: ['vision', 'streaming'] },
  { id: 'claude-opus-4-6',   displayName: 'Opus 4.6 (Great for coding & complex tasks)', provider: 'anthropic', family: 'claude-4', capabilities: ['vision', 'streaming'] },
  { id: 'claude-haiku-4-5',  displayName: 'Haiku 4.5 (Fast & cost-efficient)',           provider: 'anthropic', family: 'claude-4', capabilities: ['vision', 'streaming'] },

  // ── OpenAI - newest first ──
  { id: 'gpt-5.5',      displayName: 'GPT 5.5 (Most capable for most tasks)', provider: 'openai', family: 'gpt-5.5', capabilities: ['vision', 'streaming'] },
  { id: 'gpt-5.4-mini', displayName: 'GPT 5.4 mini (Cost-efficient)',         provider: 'openai', family: 'gpt-5.4', capabilities: ['vision', 'streaming'] },
  { id: 'gpt-5.4-nano', displayName: 'GPT 5.4 nano (Most cost-efficient)',    provider: 'openai', family: 'gpt-5.4', capabilities: ['vision', 'streaming'] },
  { id: 'gpt-5.4',      displayName: 'GPT 5.4 (Legacy)',                      provider: 'openai', family: 'gpt-5.4', capabilities: ['vision', 'streaming'] },

  // ── Google Gemini - newest first ──
  { id: 'gemini-3.1-pro-preview',        displayName: '3.1 Pro (Most capable model)',              provider: 'gemini', family: 'gemini-3.1', capabilities: ['vision', 'streaming'] },
  { id: 'gemini-3.1-flash-lite-preview', displayName: '3.1 Flash Lite (Recommended for most tasks)', provider: 'gemini', family: 'gemini-3.1', capabilities: ['vision', 'streaming'] },
  { id: 'gemini-3-flash-preview',        displayName: '3 Flash (Fast & capable)',                  provider: 'gemini', family: 'gemini-3',   capabilities: ['vision', 'streaming'] },
  { id: 'gemini-2.5-pro',                displayName: '2.5 Pro (Legacy)',                          provider: 'gemini', family: 'gemini-2.5', capabilities: ['vision', 'streaming'] },
  { id: 'gemini-2.5-flash',              displayName: '2.5 Flash (Legacy)',                        provider: 'gemini', family: 'gemini-2.5', capabilities: ['vision', 'streaming'] },
  { id: 'gemini-2.5-flash-lite',         displayName: '2.5 Flash Lite (Legacy)',                   provider: 'gemini', family: 'gemini-2.5', capabilities: ['vision', 'streaming'] },
];

/**
 * Provider-level metadata (connection + UI chrome). Model lists are derived
 * from MODELS - never duplicate provider info elsewhere; read it from here.
 *
 * `label`      - long form, used in settings UI and error messages.
 * `shortLabel` - compact form, used in the sidepanel chip / badge.
 */
export const PROVIDERS = {
  anthropic: { label: 'Anthropic Claude', shortLabel: 'Claude', keyPlaceholder: 'sk-ant-…', keyPrefix: 'sk-ant-' },
  openai:    { label: 'OpenAI',           shortLabel: 'GPT',    keyPlaceholder: 'sk-…',     keyPrefix: 'sk-'     },
  gemini:    { label: 'Google Gemini',    shortLabel: 'Gemini', keyPlaceholder: 'AIza…',    keyPrefix: 'AIza'    },
};

/** All models for a provider, in declaration order. */
export function getModelsByProvider(provider) {
  return MODELS.filter((m) => m.provider === provider);
}

/** Lookup by id. Returns null for unknown ids - callers should not treat that as invalid. */
export function getModelById(id) {
  return MODELS.find((m) => m.id === id) ?? null;
}

export const DEFAULT_SETTINGS = {
  // Which provider is active
  provider: 'anthropic',

  // Per-provider API keys
  anthropicApiKey: '',
  openaiApiKey: '',
  geminiApiKey: '',

  // Per-provider model selections - defaults point at each provider's newest family.
  anthropicModel: 'claude-opus-4-7',
  openaiModel:    'gpt-5.4',
  geminiModel:    'gemini-2.5-flash',

  // Glance master gate. Replaces the older `screenshotEnabled` key (migrated in
  // getSettings). When OFF, no page inspection happens at all - no manifest,
  // no screenshot, no DOM extraction, no planner. Pure chat.
  glanceEnabled: true,

  // Screenshot tool settings (only consulted when Glance is ON and the planner
  // chooses to gather a screenshot).
  screenshotQuality: 70,   // JPEG quality 1-100
  maxImageWidth: 1280,     // px, before sending to API

  blockedDomains: [],

  // ── Context routing (Stage A scaffolding) ───────────────────────────────
  // Hidden internal flag. Controls whether Glance-ON routes through the new
  // LLM1 planner flow or the existing single-shot screenshot path. Stays
  // false during MVP until telemetry validates the new flow on real traffic.
  // Edit via chrome.storage.sync.set in DevTools to flip during dev.
  _internalUsePlannerFlow: false,

  // Planner (LLM1) provider/model. GPT-5-nano via the OpenAI API for MVP.
  // Reuses the user's openaiApiKey (settings.openaiApiKey) when the planner
  // is enabled - if no OpenAI key exists, the orchestrator falls back to the
  // defaultPlannerFailurePackage rather than calling out.
  plannerProvider: 'openai',
  plannerModelId:  'gpt-5-nano-2025-08-07',

  // Maximum number of LLM2 fallback round-trips per turn.
  plannerMaxFallbacks: 1,

  // Package used when the planner returns invalid JSON or invalid context_types.
  // Errs on the side of correctness over cost - DOM + screenshot is the safest
  // superset of the MVP tool palette. Tunable.
  defaultPlannerFailurePackage: ['viewport_dom', 'viewport_screenshot'],

  // Telemetry chip below each assistant message in the side panel. Surfaces
  // estimated-vs-actual cost, planner decision, fallback state, latency.
  showTelemetry: true,
};

/** Returns the API key for the currently selected provider. */
export function getActiveApiKey(settings) {
  return settings[`${settings.provider}ApiKey`] ?? '';
}

/**
 * Returns the model id for the currently selected provider.
 * If the stored value is unknown to MODELS, it is still returned as-is - we do
 * not silently downgrade to a "known" model. The API call will surface any
 * genuine error from the provider.
 */
export function getActiveModel(settings) {
  const stored = settings[`${settings.provider}Model`];
  if (stored) return stored;
  return getModelsByProvider(settings.provider)[0]?.id ?? '';
}

/**
 * Load settings, merging stored values over defaults.
 *
 * Performs a one-shot migration from the legacy `screenshotEnabled` key to
 * `glanceEnabled` on first read after upgrade. Existing users keep their
 * prior toggle state under the new name, and the old key is removed so it
 * can't drift out of sync with the new one.
 */
export async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (raw) => {
      const stored = raw ?? {};

      const needsMigration = ('screenshotEnabled' in stored) && !('glanceEnabled' in stored);
      if (needsMigration) {
        const migratedValue = stored.screenshotEnabled;
        chrome.storage.sync.set({ glanceEnabled: migratedValue }, () => {
          chrome.storage.sync.remove('screenshotEnabled', () => {
            stored.glanceEnabled = migratedValue;
            delete stored.screenshotEnabled;
            resolve({ ...DEFAULT_SETTINGS, ...stored });
          });
        });
        return;
      }

      resolve({ ...DEFAULT_SETTINGS, ...stored });
    });
  });
}

/** Persist a partial settings object (only provided keys are updated). */
export async function saveSettings(partial) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(partial, resolve);
  });
}

/** Watch for setting changes and call the callback with the changed values. */
export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const updated = {};
    for (const [key, { newValue }] of Object.entries(changes)) {
      updated[key] = newValue;
    }
    callback(updated);
  });
}
