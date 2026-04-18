/**
 * Chrome storage wrapper with typed defaults.
 * All settings live in chrome.storage.sync so they roam with the user's Chrome profile.
 */

/**
 * Single source of truth for every supported model across providers.
 *
 * Entry shape:
 *   { id, displayName, provider, family, capabilities? }
 *
 * `capabilities` is optional metadata (e.g. 'vision', 'streaming', 'reasoning').
 * It is informational — no code path gates behavior on a specific capability,
 * and no code path special-cases a specific model id or family.
 */
export const MODELS = [
  // ── Anthropic ──
  { id: 'claude-opus-4-7',           displayName: 'Claude Opus 4.7 (Best)',       provider: 'anthropic', family: 'claude-4',   capabilities: ['vision', 'streaming'] },
  { id: 'claude-sonnet-4-6',         displayName: 'Claude Sonnet 4.6 (Balanced)', provider: 'anthropic', family: 'claude-4',   capabilities: ['vision', 'streaming'] },
  { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5 (Fast)',      provider: 'anthropic', family: 'claude-4',   capabilities: ['vision', 'streaming'] },

  // ── OpenAI — GPT-5.4 (newest) ──
  { id: 'gpt-5.4',      displayName: 'GPT-5.4',      provider: 'openai', family: 'gpt-5.4' },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', provider: 'openai', family: 'gpt-5.4' },
  { id: 'gpt-5.4-nano', displayName: 'GPT-5.4 nano', provider: 'openai', family: 'gpt-5.4' },

  // ── OpenAI — prior families retained ──
  { id: 'gpt-4.1',      displayName: 'GPT-4.1',           provider: 'openai', family: 'gpt-4.1', capabilities: ['vision', 'streaming'] },
  { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini',      provider: 'openai', family: 'gpt-4.1', capabilities: ['vision', 'streaming'] },
  { id: 'gpt-4.1-nano', displayName: 'GPT-4.1 nano',      provider: 'openai', family: 'gpt-4.1', capabilities: ['vision', 'streaming'] },
  { id: 'gpt-4o',       displayName: 'GPT-4o',            provider: 'openai', family: 'gpt-4o',  capabilities: ['vision', 'streaming'] },
  { id: 'gpt-4o-mini',  displayName: 'GPT-4o mini',       provider: 'openai', family: 'gpt-4o',  capabilities: ['vision', 'streaming'] },
  { id: 'o4-mini',      displayName: 'o4-mini (reasoning)', provider: 'openai', family: 'o-series', capabilities: ['reasoning', 'streaming'] },
  { id: 'o3',           displayName: 'o3 (reasoning)',      provider: 'openai', family: 'o-series', capabilities: ['reasoning', 'streaming'] },
  { id: 'o1',           displayName: 'o1 (reasoning)',      provider: 'openai', family: 'o-series', capabilities: ['reasoning'] },

  // ── Google Gemini ──
  { id: 'gemini-2.0-flash-exp', displayName: 'Gemini 2.0 Flash (Recommended)', provider: 'gemini', family: 'gemini-2',   capabilities: ['vision', 'streaming'] },
  { id: 'gemini-1.5-pro',       displayName: 'Gemini 1.5 Pro (Best quality)',  provider: 'gemini', family: 'gemini-1.5', capabilities: ['vision', 'streaming'] },
  { id: 'gemini-1.5-flash',     displayName: 'Gemini 1.5 Flash (Fast)',        provider: 'gemini', family: 'gemini-1.5', capabilities: ['vision', 'streaming'] },
];

/** Provider-level metadata (connection + UI chrome). Model lists are derived from MODELS. */
export const PROVIDERS = {
  anthropic: { label: 'Anthropic Claude', keyPlaceholder: 'sk-ant-…', keyPrefix: 'sk-ant-' },
  openai:    { label: 'OpenAI',           keyPlaceholder: 'sk-…',     keyPrefix: 'sk-'     },
  gemini:    { label: 'Google Gemini',    keyPlaceholder: 'AIza…',    keyPrefix: 'AIza'    },
};

/** All models for a provider, in declaration order. */
export function getModelsByProvider(provider) {
  return MODELS.filter((m) => m.provider === provider);
}

/** Lookup by id. Returns null for unknown ids — callers should not treat that as invalid. */
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

  // Per-provider model selections — defaults point at each provider's newest family.
  anthropicModel: 'claude-opus-4-7',
  openaiModel:    'gpt-5.4',
  geminiModel:    'gemini-2.0-flash-exp',

  // Screenshot settings
  screenshotEnabled: true,
  screenshotQuality: 70,   // JPEG quality 1-100
  maxImageWidth: 1280,     // px, before sending to API

  blockedDomains: [],
};

/** Returns the API key for the currently selected provider. */
export function getActiveApiKey(settings) {
  return settings[`${settings.provider}ApiKey`] ?? '';
}

/**
 * Returns the model id for the currently selected provider.
 * If the stored value is unknown to MODELS, it is still returned as-is — we do
 * not silently downgrade to a "known" model. The API call will surface any
 * genuine error from the provider.
 */
export function getActiveModel(settings) {
  const stored = settings[`${settings.provider}Model`];
  if (stored) return stored;
  return getModelsByProvider(settings.provider)[0]?.id ?? '';
}

/** Load settings, merging stored values over defaults. */
export async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (result) => {
      resolve(result);
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
