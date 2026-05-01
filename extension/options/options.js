/**
 * AutoGlance Options Page
 * Per-section save: auto-save for toggles/selects, Apply buttons for keys/domains.
 */

import { getSettings, saveSettings, DEFAULT_SETTINGS, PROVIDERS } from '../lib/storage.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let activeProvider = 'anthropic';

async function init() {
  settings = await getSettings();
  activeProvider = ['anthropic', 'gemini'].includes(settings.provider)
    ? settings.provider
    : 'anthropic';

  populateForm(settings);
  initSlider();
  bindEvents();
  updateGlanceLock();
  updateGlanceBody();
}

// ── Segmented slider ──────────────────────────────────────────────────────

function initSlider() {
  selectProvider(activeProvider, false);
}

function selectProvider(provider, animate = true) {
  activeProvider = provider;

  document.querySelectorAll('.slider-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.provider === provider);
    btn.setAttribute('aria-checked', btn.dataset.provider === provider ? 'true' : 'false');
  });

  const pill   = $('slider-pill');
  const active = document.querySelector(`.slider-option[data-provider="${provider}"]`);
  const track  = active.parentElement;

  if (!animate) pill.style.transition = 'none';

  const trackRect  = track.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  pill.style.left  = (activeRect.left - trackRect.left - 4) + 'px';
  pill.style.width = activeRect.width + 'px';

  if (!animate) {
    requestAnimationFrame(() => { pill.style.transition = ''; });
  }

  ['anthropic', 'gemini'].forEach((p) => {
    $(`panel-${p}`).classList.toggle('hidden', p !== provider);
  });
}

// ── Form ──────────────────────────────────────────────────────────────────

function populateForm(s) {
  $('anthropic-key').value = s.anthropicApiKey ?? '';
  $('openai-key').value    = s.openaiApiKey    ?? '';
  $('gemini-key').value    = s.geminiApiKey    ?? '';

  $('glance-enabled').checked      = s.glanceEnabled     ?? true;
  $('screenshot-quality').value    = s.screenshotQuality ?? 70;
  $('quality-value').textContent   = `${s.screenshotQuality ?? 70}%`;
  $('max-width').value             = String(s.maxImageWidth ?? 1280);
  $('developer-telemetry').checked = s.developerTelemetry ?? false;

  $('blocked-domains').value = (s.blockedDomains ?? DEFAULT_SETTINGS.blockedDomains).join('\n');
}

// ── Events ────────────────────────────────────────────────────────────────

function bindEvents() {
  // Provider slider
  document.querySelectorAll('.slider-option').forEach((btn) => {
    btn.addEventListener('click', () => selectProvider(btn.dataset.provider));
  });

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

  // Auto-save: Glance & Visual Capture
  $('glance-enabled').addEventListener('change', async () => {
    updateGlanceBody();
    await autoSave({ glanceEnabled: $('glance-enabled').checked });
  });

  $('screenshot-quality').addEventListener('change', async (e) => {
    await autoSave({ screenshotQuality: parseInt(e.target.value, 10) });
  });

  $('max-width').addEventListener('change', async (e) => {
    await autoSave({ maxImageWidth: parseInt(e.target.value, 10) });
  });

  // Auto-save: Developer
  $('developer-telemetry').addEventListener('change', async () => {
    const on = $('developer-telemetry').checked;
    const partial = { developerTelemetry: on };
    if (on) partial._internalUsePlannerFlow = true;
    await autoSave(partial);
  });

  // Apply API Key buttons
  $('apply-openai-key').addEventListener('click', () => applyApiKey('openai'));
  $('apply-anthropic-key').addEventListener('click', () => applyApiKey('anthropic'));
  $('apply-gemini-key').addEventListener('click', () => applyApiKey('gemini'));

  // Auto-save key fields on blur (handles deletion and edits without requiring Apply)
  $('openai-key').addEventListener('blur', () => autoSaveKey('openai'));
  $('anthropic-key').addEventListener('blur', () => autoSaveKey('anthropic'));
  $('gemini-key').addEventListener('blur', () => autoSaveKey('gemini'));


  // Privacy / Domains
  $('reset-domains').addEventListener('click', () => {
    $('blocked-domains').value = DEFAULT_SETTINGS.blockedDomains.join('\n');
  });

  $('apply-domains').addEventListener('click', applyDomains);
}

// ── Glance lock ───────────────────────────────────────────────────────────

function updateGlanceBody() {
  $('glance-settings-body').classList.toggle('disabled', !$('glance-enabled').checked);
}

function updateGlanceLock() {
  const locked = !settings.openaiApiKey;

  $('glance-lock-overlay').classList.toggle('hidden', !locked);
  $('developer-lock-overlay').classList.toggle('hidden', !locked);

  const toggle = $('glance-enabled');
  toggle.checked  = locked ? false : (settings?.glanceEnabled ?? true);
  toggle.disabled = locked;
}

// ── Auto-save (Glance & Developer toggles/selects) ────────────────────────

async function autoSave(partial) {
  await saveSettings(partial);
  Object.assign(settings, partial);
}

async function autoSaveKey(provider) {
  const inputId  = provider === 'openai' ? 'openai-key' : `${provider}-key`;
  const key = $(inputId).value.trim();
  const storageKey = `${provider}ApiKey`;

  if (key === (settings[storageKey] ?? '')) return; // nothing changed

  // For OpenAI, only auto-save a cleared field — a new/changed key must go
  // through Apply so it gets validated before unlocking the locked sections.
  if (provider === 'openai' && key !== '') return;

  await saveSettings({ [storageKey]: key });
  settings[storageKey] = key;

  if (provider === 'openai') updateGlanceLock();
}

// ── API Key Validation ────────────────────────────────────────────────────

async function validateKey(provider, key) {
  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      return res.ok;
    }

    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
      });
      return res.ok;
    }

    if (provider === 'gemini') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
      );
      return res.ok;
    }
  } catch {
    return false;
  }
  return false;
}

async function applyApiKey(provider) {
  const inputId  = provider === 'openai' ? 'openai-key' : `${provider}-key`;
  const statusId = provider === 'openai' ? 'openai-key-status' : `${provider}-key-status`;
  const btnId    = provider === 'openai' ? 'apply-openai-key' : `apply-${provider}-key`;

  const key    = $(inputId).value.trim();
  const status = $(statusId);
  const btn    = $(btnId);

  if (!key) {
    showInlineStatus(status, 'Enter a key first.', 'error');
    return;
  }

  btn.disabled = true;
  showInlineStatus(status, 'Validating…', 'loading');

  const valid = await validateKey(provider, key);

  if (valid) {
    const storageKey = `${provider}ApiKey`;
    const partial = { [storageKey]: key };

    // For anthropic/gemini, also set provider so sidepanel knows which to use
    if (provider !== 'openai') {
      partial.provider = provider;
      activeProvider = provider;
    }

    await saveSettings(partial);
    Object.assign(settings, partial);

    if (provider === 'openai') {
      updateGlanceLock();
      updateGlanceBody();
      // Switch to OpenAI as the active chat provider when no other provider key exists
      if (!settings[`${settings.provider}ApiKey`]) {
        await saveSettings({ provider: 'openai' });
        Object.assign(settings, { provider: 'openai' });
      }
    }

    showInlineStatus(status, '✓ Key saved & connected', 'success');
  } else {
    const label = PROVIDERS[provider]?.label ?? provider;
    showInlineStatus(status, `Invalid key — check your ${label} key and try again.`, 'error');
  }

  btn.disabled = false;
}

// ── Domain blocklist ──────────────────────────────────────────────────────

async function applyDomains() {
  const btn    = $('apply-domains');
  const status = $('domains-status');

  btn.disabled = true;

  const blockedDomains = $('blocked-domains').value
    .split('\n')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));

  await saveSettings({ blockedDomains });
  Object.assign(settings, { blockedDomains });

  $('blocked-domains').value = blockedDomains.join('\n');
  showInlineStatus(status, '✓ Blocklist saved', 'success');

  btn.disabled = false;
}

// ── Inline status helper ──────────────────────────────────────────────────

function showInlineStatus(el, message, type) {
  el.textContent = message;
  el.className = `inline-status ${type}`;
  clearTimeout(el._timeout);
  if (type !== 'loading') {
    el._timeout = setTimeout(() => { el.className = 'inline-status hidden'; }, 3500);
  }
}

init().catch(console.error);
