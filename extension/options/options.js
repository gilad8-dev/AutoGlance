/**
 * AutoGlance Options Page
 * Drives the segmented provider slider and saves all settings.
 */

import { getSettings, saveSettings, DEFAULT_SETTINGS, getModelsByProvider, getModelById, PROVIDERS } from '../lib/storage.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let activeProvider = 'anthropic';

async function init() {
  settings = await getSettings();
  activeProvider = settings.provider ?? 'anthropic';

  populateModelDropdowns(settings);
  populateForm(settings);
  initSlider();
  bindEvents();
}

// ── Model dropdowns ───────────────────────────────────────────────────────

/**
 * Populate every <select data-provider-models="..."> from the central MODELS
 * registry. The stored model id (if any) is guaranteed to appear as an option,
 * even if it is no longer in MODELS - we never silently downgrade a user's
 * saved choice to a different model.
 */
function populateModelDropdowns(s) {
  document.querySelectorAll('select[data-provider-models]').forEach((select) => {
    const provider = select.dataset.providerModels;
    const stored   = s[`${provider}Model`] ?? '';
    const known    = getModelsByProvider(provider);

    select.innerHTML = '';
    for (const m of known) {
      select.appendChild(buildOption(m.id, m.displayName));
    }

    // Preserve an unknown-but-previously-saved id so we don't mutate user state.
    if (stored && !getModelById(stored)) {
      select.appendChild(buildOption(stored, `${stored} (saved)`));
    }
  });
}

function buildOption(value, label) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  return opt;
}

// ── Segmented slider ──────────────────────────────────────────────────────

function initSlider() {
  selectProvider(activeProvider, false); // false = no animation on first paint
}

function selectProvider(provider, animate = true) {
  activeProvider = provider;

  // Update option button states
  document.querySelectorAll('.slider-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.provider === provider);
    btn.setAttribute('aria-checked', btn.dataset.provider === provider ? 'true' : 'false');
  });

  // Move the sliding pill
  const pill   = $('slider-pill');
  const active = document.querySelector(`.slider-option[data-provider="${provider}"]`);
  const track  = active.parentElement;

  if (!animate) pill.style.transition = 'none';

  const trackRect  = track.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  pill.style.left  = (activeRect.left - trackRect.left - 4) + 'px'; // -4 = slider padding
  pill.style.width = activeRect.width + 'px';

  if (!animate) {
    // Re-enable animation after one frame
    requestAnimationFrame(() => { pill.style.transition = ''; });
  }

  // Show/hide provider panels
  Object.keys(PROVIDERS).forEach((p) => {
    $(`panel-${p}`).classList.toggle('hidden', p !== provider);
  });
}

// ── Form ──────────────────────────────────────────────────────────────────

function populateForm(s) {
  $('anthropic-key').value   = s.anthropicApiKey ?? '';
  $('openai-key').value      = s.openaiApiKey    ?? '';
  $('gemini-key').value      = s.geminiApiKey    ?? '';

  $('anthropic-model').value = s.anthropicModel  ?? DEFAULT_SETTINGS.anthropicModel;
  $('openai-model').value    = s.openaiModel     ?? DEFAULT_SETTINGS.openaiModel;
  $('gemini-model').value    = s.geminiModel     ?? DEFAULT_SETTINGS.geminiModel;

  $('screenshot-enabled').checked = s.screenshotEnabled ?? true;
  $('screenshot-quality').value   = s.screenshotQuality ?? 70;
  $('quality-value').textContent  = `${s.screenshotQuality ?? 70}%`;
  $('max-width').value            = String(s.maxImageWidth  ?? 1280);

  $('blocked-domains').value = (s.blockedDomains ?? DEFAULT_SETTINGS.blockedDomains).join('\n');
}

// ── Events ────────────────────────────────────────────────────────────────

function bindEvents() {
  // Provider slider buttons
  document.querySelectorAll('.slider-option').forEach((btn) => {
    btn.addEventListener('click', () => selectProvider(btn.dataset.provider));
  });

  // Re-position pill if window resizes (layout reflow can shift positions)
  window.addEventListener('resize', () => selectProvider(activeProvider, false));

  // Quality slider preview
  $('screenshot-quality').addEventListener('input', (e) => {
    $('quality-value').textContent = `${e.target.value}%`;
  });

  // Show/hide API key toggles
  document.querySelectorAll('.toggle-key').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  $('reset-domains').addEventListener('click', () => {
    $('blocked-domains').value = DEFAULT_SETTINGS.blockedDomains.join('\n');
  });

  $('save-btn').addEventListener('click', handleSave);
}

// ── Save ──────────────────────────────────────────────────────────────────

async function handleSave() {
  const saveBtn = $('save-btn');
  saveBtn.disabled = true;

  try {
    const activeKey = {
      anthropic: $('anthropic-key').value.trim(),
      openai:    $('openai-key').value.trim(),
      gemini:    $('gemini-key').value.trim(),
    }[activeProvider];

    if (!activeKey) {
      const name = PROVIDERS[activeProvider]?.label ?? activeProvider;
      showStatus(`Add an API key for ${name} before saving.`, 'error');
      return;
    }

    const blockedDomains = $('blocked-domains').value
      .split('\n')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean)
      .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));

    const updated = {
      provider:         activeProvider,
      anthropicApiKey:  $('anthropic-key').value.trim(),
      openaiApiKey:     $('openai-key').value.trim(),
      geminiApiKey:     $('gemini-key').value.trim(),
      anthropicModel:   $('anthropic-model').value,
      openaiModel:      $('openai-model').value,
      geminiModel:      $('gemini-model').value,
      screenshotEnabled: $('screenshot-enabled').checked,
      screenshotQuality: parseInt($('screenshot-quality').value, 10),
      maxImageWidth:     parseInt($('max-width').value, 10),
      blockedDomains,
    };

    await saveSettings(updated);
    Object.assign(settings, updated);
    showStatus('✓ Settings saved', 'success');
  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
  }
}

function showStatus(message, type) {
  const el = $('save-status');
  el.textContent = message;
  el.className = `save-status ${type}`;
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => { el.className = 'save-status hidden'; }, 3500);
}

init().catch(console.error);
