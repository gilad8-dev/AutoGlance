# AutoGlance

> AI browser copilot with visual page understanding

AutoGlance is a Chrome Extension (Manifest V3) that opens a side-panel chat inside Chrome. Each message can automatically include browser context — a screenshot, a sanitized DOM extract, or nothing at all — giving the model exactly what it needs to answer about the current page.

---

## Features

- **Side-panel chat** — persistent, non-intrusive, always accessible
- **Smart context planning** — a cheap LLM decides what to gather before the answering model runs
- **Multi-provider support** — Anthropic Claude, OpenAI GPT, Google Gemini
- **Streaming responses** — text streams in as the model generates (Anthropic); full-response delivery for OpenAI/Gemini
- **Privacy-first** — per-domain blocklist, one-click Glance toggle, visual status bar
- **Markdown rendering** — code blocks, math (KaTeX), syntax highlighting, lists, bold/italic
- **Conversation history** — multi-turn context with DOM text enrichment across turns
- **Per-turn telemetry** — estimated vs actual token counts, costs, latency, and planner decisions

---

## Setup

### 1. Generate Icons (one-time)

```bash
node scripts/generate-icons.js
```

Creates `extension/icons/icon{16,32,48,128}.png`. Requires Node.js; no npm packages needed.

### 2. Load the Extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder

### 3. Configure Your API Key

1. Click the AutoGlance icon → **Settings** (gear icon)
2. Select a provider (Claude / GPT / Gemini) and enter the corresponding API key
3. Choose a model and click **Save**

---

## Using AutoGlance

Type any question in the chat input and press **Enter** (Shift+Enter for a newline).

| Prompt | What it does |
|--------|-------------|
| `What am I looking at?` | Describes the current page |
| `Summarize this article` | Summarizes visible content |
| `Where do I click to sign up?` | Locates UI elements |
| `Explain the chart on screen` | Interprets visible graphs or dashboards |
| `Why is this page showing an error?` | Diagnoses visible errors |

### Input-area toggles

| Toggle | Icon | Purpose |
|--------|------|---------|
| **Glance** | Eye | Master gate. When OFF, no page inspection runs — pure text chat |
| **Planner** | Star | Enables the LLM1→gather→LLM2 flow. When OFF, falls back to the legacy screenshot-always path |
| **Shadow** | Split-panel | Dev only. Runs a real legacy screenshot call in parallel so telemetry shows actual-vs-actual cost comparison |

---

## Architecture

AutoGlance has two execution paths, selected at the start of each turn.

### Legacy flow

```
User prompt
    │
    ├─ captureScreenshot()
    └─ streamMessage(screenshot + prompt + history) → LLM2 → answer
```

Always attaches a viewport screenshot. Simple and reliable, but expensive — every turn pays full image token cost regardless of whether the page has changed.

### Planner flow

```
User prompt
    │
    ├─ buildManifest()            ← page facts only, no raw text
    ├─ computeChangeSignals()     ← boolean deltas vs prior turn
    │
    ├─[domReliable === false]────→ REVERT to legacy flow
    │
    ├─ pre-extract DOM            ← exact post-sanitization token count, ~5–30 ms
    ├─ buildPlannerCostMenu()     ← none=0 tok  vs  context_needed=cheapest tool tok
    ├─ planContext() [LLM1]       ← binary decision: none or context_needed
    │       │
    │       ├─ "none" ──────────→ streamMessage() directly (no context, no protocol)
    │       │                              └─ answer
    │       │
    │       └─ "context_needed"
    │               │
    │               ├─[DOM cheaper]──→ gatherTools(viewport_dom)
    │               └─[SS  cheaper]──→ gatherTools(viewport_screenshot)
    │                       │
    │               askLLM2() [LLM2]  ← structured-output protocol
    │                       │
    │                       ├─ provide_answer ──→ answer
    │                       └─ request_more_context
    │                               │
    │                       gatherTools(viewport_screenshot)  ← fallback, max 1×
    │                               │
    │                       askLLM2() [LLM2] round 2
    │                               │
    │                               ├─ provide_answer ──→ answer
    │                               └─ request_more_context ──→ degrade → answer
```

#### Decision flow

```
1. LLM1 — is fresh context needed?
   No  → 7  (stream directly, no context attached)
   Yes → 2

2. Compare estimated token cost: viewport DOM vs screenshot
   DOM cheaper  → 6
   SS  cheaper  → 3

3. Capture & compress viewport screenshot → 4

4. Feed screenshot to LLM2 → 5

5. Answer ✓

6. Extract & sanitize viewport DOM
   (pre-extraction result reused if already run in step 1 setup) → 7

7. Feed context to LLM2 (structured-output protocol)
   provide_answer       → 5
   request_more_context → 3  (screenshot fallback; max once, then degrade)
```

> **Note on step 7**: when arriving from the `none` branch (step 1 → 7 directly), LLM2 is streamed without the structured-output protocol — no fallback is possible. The fallback loop (→ 3) only applies when context was gathered via steps 3–6.

#### Why two models?

LLM1 (the planner) is a tiny, cheap model that receives only page metadata — no raw text, no screenshots. Its sole output is a binary routing decision: `none` or `context_needed`. The specific context tool (DOM vs screenshot) is chosen deterministically by the orchestrator (cheapest option wins), never by LLM1. This design removes quality-vs-cost bias from the planner's reasoning entirely.

---

## Components

```
AutoGlance/
├── extension/
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js      Screenshot capture, tab info relay, message router
│   ├── sidepanel/
│   │   ├── index.html             Side-panel UI shell
│   │   ├── sidepanel.js           Turn orchestrator — runs the full planner flow
│   │   └── sidepanel.css          Styles
│   ├── options/
│   │   ├── options.html
│   │   ├── options.js
│   │   └── options.css
│   └── lib/
│       ├── storage.js             Settings schema, MODELS registry, PROVIDERS metadata
│       ├── privacy-rules.js       Domain blocklist + sensitive-keyword detection
│       ├── page-manifest.js       In-page extractor + buildManifest() host side
│       ├── change-signals.js      Per-tab manifest history, change-signal computation
│       ├── context-tools.js       DOM extraction, screenshot capture, gatherTools()
│       ├── context-builder.js     Legacy prompt/context assembly + image compression
│       ├── planner.js             LLM1 — planContext(), validateDecision(), cost menu
│       ├── llm2-protocol.js       LLM2 — askLLM2(), provider strategies, message builders
│       ├── ai-client.js           Legacy Anthropic streaming client
│       ├── cost-estimator.js      Token + cost estimation for all providers/tools
│       └── telemetry.js           Per-turn record, in-memory map, ring buffer (last 50)
└── scripts/
    └── generate-icons.js
```

### lib/storage.js — model registry

Single source of truth for every supported model.

| Field | Purpose |
|-------|---------|
| `id` | Exact API identifier sent to the provider |
| `displayName` | Human-readable label in dropdowns |
| `provider` | Routing key: `anthropic` / `openai` / `gemini` |
| `family` | Grouping label (e.g. `claude-4`, `gemini-3.1`) |
| `capabilities` | Informational tags (`vision`, `streaming`) |

### lib/page-manifest.js — page manifest

Runs `extractManifestInPage()` inside the page via `chrome.scripting.executeScript`. Returns structural facts only — no raw text, no attribute values.

| Field | Type | Description |
|-------|------|-------------|
| `url`, `title` | string | Page identity |
| `viewportW`, `viewportH` | number | Viewport dimensions (px) |
| `scrollY`, `scrollMaxY` | number | Scroll position and maximum |
| `visibleTextLength` | number | Total visible text character count |
| `fullTextLengthEstimate` | number | `textContent.length` of body |
| `visibleImageCount` | number | Images intersecting the viewport |
| `hasLargeVisibleImage` | bool | Any image ≥ 200×200 px |
| `hasCanvas`, `hasSvg`, `hasTable`, `hasFormInput` | bool | Element-type presence flags |
| `hasFocusedElement`, `focusedElementType` | bool/str | Active focus state |
| `hasCrossOriginIframes` | bool | DOM tools may miss iframe content |
| `domReliable` | bool | `false` when canvas-dominant (>50% viewport) or `visibleTextLength < 200` |
| `visibleDomHash` | string | djb2 of first 4 KB of visible text — change detection |
| `mediaHash` | string | djb2 of visible `<img>` src list — change detection |

`domReliable === false` triggers a hard revert to the legacy flow before the planner runs. Affected pages include PDF viewers, whiteboards, map tiles, and canvas-heavy apps.

### lib/change-signals.js — change signals

Compares the current manifest against the last-seen manifest for that tab. The result is a boolean record the planner uses to decide whether `"none"` is safe.

| Signal | True when |
|--------|-----------|
| `is_first_message` | No prior turn this session |
| `tab_changed_since_last` | Different tab from the previous turn |
| `url_changed_since_last` | Same tab, different URL |
| `viewport_size_changed` | Viewport dimensions differ |
| `scroll_position_changed` | `\|ΔscrollY\| > 50 px` |
| `visible_dom_hash_changed` | Visible text fingerprint changed |
| `media_hash_changed` | Visible image src list changed |
| `ms_since_last_turn` | Time since previous turn (ms) |

### lib/planner.js — LLM1

**Model**: `gpt-5-nano-2025-08-07` via OpenAI API. Non-streaming, one-shot, 15 s timeout.

**Input** (JSON user message):

```
user_prompt
conversation_has_prior_turns
change_signals
page_manifest               (summarized facts only)
available_context_types     ["none", "context_needed"]
context_options             (two-entry cost menu)
```

**Output** (strict JSON, schema-enforced):

```json
{
  "context_types": ["none"] | ["context_needed"],
  "reason": "...",
  "fallback_risk": "low"
}
```

**Decision rules** (v5 — binary):

1. `"none"` — zero extra tokens. Use only when **all** of the following hold:
   - `conversation_has_prior_turns` is true
   - All change signals are false
   - The prompt does not signal new or different content
   - `dom_reliable` is true
2. `"context_needed"` — for everything else. The orchestrator picks the cheapest available tool (DOM or screenshot) automatically.
3. `fallback_risk` reflects the probability that LLM2 will need additional context after the chosen package.

LLM1 never chooses between DOM and screenshot — that decision is deterministic (cheapest wins) and handled entirely by the orchestrator.

**Validation** (`validateDecision`): JSON parse → schema shape → type membership → `"none"` rule enforcement. On any failure, falls back to `['context_needed']` so the orchestrator gathers the cheapest available tool.

**`"none"` guard** (`isNoneAllowed_V1Strict`): hard-blocks `"none"` if:
- No prior turns exist
- `domReliable === false` (change signals are blind on canvas/PDF pages)
- Any change signal is `true`

### lib/llm2-protocol.js — LLM2

The answering model. Two protocol strategies depending on provider:

**Anthropic — native tool calling** (streaming):

LLM2 is offered a single tool: `request_more_context`. If context is sufficient, it streams a normal text answer. If not, it calls the tool specifying the additional types it needs.

**OpenAI / Gemini — JSON envelope** (non-streaming):

LLM2 is instructed to prepend a one-line JSON envelope before its answer:

```
{"action":"provide_answer"}
<answer text starting on next line>
```

or

```
{"action":"request_more_context","requested_context_types":["viewport_screenshot"],"reason":"..."}
```

If the envelope is missing or malformed, the full response is treated as `provide_answer` (raw-degrade path).

**Fallback loop**: the orchestrator retries once (`plannerMaxFallbacks = 1`) if LLM2 requests more context. On the retry, the additional tools are gathered and merged into the package.

**History enrichment**: after each planner-flow turn, the actual browser context text sent to LLM2 (`buildBrowserContextText(finalPackage)`) is written back into the user's conversation history entry. Subsequent turns therefore have the DOM text in memory without re-gathering it.

**`"none"` annotation**: when the planner picks `"none"` on a turn with prior history, the user prompt is appended with:

```
[AutoGlance: page unchanged since last turn — answer from conversation history, no new context needed]
```

This annotation is sent to the model but not stored in history. It prevents LLM2 from wondering why no context was attached and ensures it answers confidently from conversation memory.

---

## Token Estimation

Rates and formulas are implemented in `lib/cost-estimator.js`, used by the planner (via `buildCostMenu`) and telemetry (via `estimateOldFlowBaseline`).

### Text tokens

```
tokens = ceil(char_count / 4)
```

Applied to system prompt, history, user prompt, and DOM text blocks.

### DOM context cap

| Tool | Cap (chars) | Notes |
|------|-------------|-------|
| `viewport_dom` | 6,000 | Sanitized visible DOM |
| `full_page_dom` | 40,000 | Full document DOM |

DOM text is estimated to expand ~1.4× in tags vs raw text: `effective_chars = visible_text_length × 1.4`, then capped.

### Image tokens — Anthropic

```
tokens = ceil(width × height / 750)
```

Applied after compression: images wider than `maxImageWidth` (default 1280 px) are scaled proportionally first.

```
if width > maxImageWidth:
    height = round(height × maxImageWidth / width)
    width  = maxImageWidth

tokens = ceil(width × height / 750)
```

### Image tokens — OpenAI (patch-based: gpt-5.4-mini, gpt-5.4-nano)

Source: OpenAI developer docs — patch-based tokenization. Patch budget: **1,536**.

```
A.  original_patches = ceil(width/32) × ceil(height/32)

B.  if original_patches > budget:
        shrink = sqrt(32² × budget / (width × height))
        adjusted = shrink × min(
            floor(width  × shrink / 32) / (width  × shrink / 32),
            floor(height × shrink / 32) / (height × shrink / 32)
        )
        resized_width  = floor(width  × adjusted)
        resized_height = floor(height × adjusted)
        resized_patches = min(ceil(resized_width/32) × ceil(resized_height/32), budget)
    else:
        resized_patches = original_patches

C.  tokens = round(resized_patches × multiplier)
```

| Model | Multiplier |
|-------|-----------|
| `gpt-5.4-mini` | 1.62 |
| `gpt-5.4-nano` | 2.46 |

### Image tokens — OpenAI (tile-based: gpt-5.5, gpt-5.4)

Source: OpenAI developer docs — tile-based tokenization (high detail).

```
1.  Scale to fit within 2048×2048 (maintain aspect ratio).
2.  Scale so that the shortest side = 768 px.
3.  tiles  = ceil(width/512) × ceil(height/512)
    tokens = base + tiles × tile_cost
```

| Model | Base tokens | Tile tokens | Notes |
|-------|-------------|-------------|-------|
| `gpt-5.5` | 70 | 140 | Proxy from gpt-5 / gpt-5-chat-latest |
| `gpt-5.4` | 85 | 170 | Proxy from gpt-4o / gpt-4.1 / gpt-4.5 |

### Image tokens — Gemini

Source: Gemini token calculation docs.

```
if width ≤ 384 and height ≤ 384:
    tokens = 258
else:
    crop_unit = floor(min(width, height) / 1.5)
    tiles     = ceil(width / crop_unit) × ceil(height / crop_unit)
    tokens    = tiles × 258
```

Applied after any `maxImageWidth` compression.

### Old-flow baseline estimate

Used to compute the "saved vs old flow" delta in the telemetry chip.

```
input_text_tokens  = ceil((system_prompt_chars + history_chars + user_prompt_chars) / 4)
image_tokens       = formula above for the active model + compressed viewport dimensions
input_tokens       = input_text_tokens + image_tokens
output_tokens      = 400   (fixed assumption; replaced by shadow actual when available)

est_cost_USD = (input_tokens / 1e6 × in_rate) + (output_tokens / 1e6 × out_rate)
```

`history_chars` uses `conversationHistory.slice(0, -1)` to exclude the current user turn, which is counted separately as `user_prompt_chars`.

---

## Pricing

Rates are hard-coded in `lib/cost-estimator.js`. Update when published rates change. Routing decisions require only relative ordering; ±25% accuracy is sufficient.

### Anthropic

| Model | In ($/1M) | Out ($/1M) |
|-------|-----------|------------|
| `claude-opus-4-7` | $5.00 | $25.00 |
| `claude-opus-4-6` | $5.00 | $25.00 |
| `claude-sonnet-4-6` | $3.00 | $15.00 |
| `claude-haiku-4-5` | $1.00 | $5.00 |

### OpenAI

| Model | In ($/1M) | Out ($/1M) |
|-------|-----------|------------|
| `gpt-5-nano-2025-08-07` *(planner)* | $0.05 | $0.40 |
| `gpt-5.5` | $5.00 | $30.00 |
| `gpt-5.4` | $2.50 | $15.00 |
| `gpt-5.4-mini` | $0.75 | $4.50 |
| `gpt-5.4-nano` | $0.20 | $1.25 |

### Google Gemini

| Model | In ($/1M) | Out ($/1M) |
|-------|-----------|------------|
| `gemini-3.1-pro-preview` | $2.00 | $12.00 |
| `gemini-3.1-flash-lite-preview` | $0.25 | $1.50 |
| `gemini-3-flash-preview` | $0.50 | $3.00 |
| `gemini-2.5-pro` | $1.25 | $10.00 |
| `gemini-2.5-flash` | $0.10 | $0.40 |
| `gemini-2.5-flash-lite` | $0.10 | $0.40 |

---

## Telemetry

Each assistant turn produces a telemetry record. Records are kept in an in-memory map (`turnId → record`) for the current session and persisted to a `chrome.storage.local` ring buffer (last 50 entries) across sessions. Raw LLM response text and `_finalized` flags are stripped before persistence.

### Record structure

```
turnId, startedAt, endedAt

planner:
  actualInputTokens, actualOutputTokens, actualCostUSD
  estCostUSD (from cost menu)
  latencyMs, source, promptVersion, fallback_risk
  rawResponse, validatedDecision

package:
  context_types, estTokens, estCostUSD, breakdown (per tool)

llm2:
  actualInputTokens, actualOutputTokens, actualCostUSD
  latencyMs, provider, model, source

oldFlowBaseline:
  estInputTokens, estOutputTokens, estCostUSD, breakdown

shadowOldFlow (when shadow toggle is ON):
  actualInputTokens, actualOutputTokens, actualCostUSD

totals:
  actualCostUSD   = planner.actualCostUSD + llm2.actualCostUSD
  estCostUSD      = planner.estCostUSD + llm2.estCostUSD
  latencyMs       = endedAt − startedAt
  deltaVsOldFlow  = baselineCost − actualCostUSD
                    (uses shadow.actualCostUSD if available, else oldFlowBaseline.estCostUSD)
  deltaVsOldFlowPercent
  deltaVsEstPercent
```

### Telemetry chip

Displayed below each assistant message when `showTelemetry: true`. Click to expand the drawer:

- **Planner flow**: LLM1 actual / LLM2 actual / New-flow total / Old-flow est (or actual ⚡ when shadow ran) / Delta / Latency / Tokens (LLM2 in/out) / Planner decision
- **Legacy flow**: Cost / Tokens / Latency

### Shadow old-flow

When the shadow toggle is ON (`_internalShadowOldFlow: true`), a real legacy screenshot call runs silently after each planner turn completes. Its actual token counts and cost replace the estimated old-flow baseline in the delta calculation. **Doubles API cost per turn — dev/testing only.**

---

## Privacy

### Glance toggle

The eye icon in the input area is the master Glance gate. When OFF: no manifest, no screenshot, no DOM, no planner — pure text chat.

### Privacy status bar

| Color | Meaning |
|-------|---------|
| Green | Glance on — page context will be gathered |
| Yellow | Domain is blocked — text only |
| Gray | Glance manually off |

### Domain blocklist

Configured in **Settings → Blocked Domains** (one domain per line). Subdomains match automatically. The default blocklist includes major email, banking, healthcare, and payroll providers.

### What is sent to providers

Each turn may include:

- Your typed text
- Page title, URL, and selected text (from manifest / tab info)
- Sanitized DOM text extract (if `viewport_dom` was chosen)
- A compressed JPEG screenshot of the visible viewport (if `viewport_screenshot` was chosen)
- Conversation history (text only — screenshots are never re-sent in history)

**Nothing is stored on any server.** Requests go directly from your browser to the provider API. API keys are stored in `chrome.storage.sync`, local to your Chrome profile.

---

## Configuration reference

| Setting | Default | Description |
|---------|---------|-------------|
| `provider` | `anthropic` | Active provider |
| `anthropicApiKey` / `openaiApiKey` / `geminiApiKey` | — | Per-provider API keys |
| `anthropicModel` | `claude-opus-4-7` | Per-provider model selection |
| `glanceEnabled` | `true` | Master Glance gate |
| `screenshotQuality` | `70` | JPEG quality 1–100 |
| `maxImageWidth` | `1280` | Screenshots wider than this are downscaled |
| `blockedDomains` | `[]` | Domains where Glance is disabled |
| `_internalUsePlannerFlow` | `false` | Enables the LLM1→gather→LLM2 flow |
| `_internalShadowOldFlow` | `false` | Runs a real parallel legacy call for cost comparison |
| `plannerProvider` | `openai` | LLM1 provider |
| `plannerModelId` | `gpt-5-nano-2025-08-07` | LLM1 model |
| `plannerMaxFallbacks` | `1` | Max LLM2 re-gather rounds per turn |
| `defaultPlannerFailurePackage` | `['context_needed']` | Fallback when planner fails — orchestrator picks cheapest tool |
| `showTelemetry` | `true` | Show per-turn cost/token chip |

Internal settings (`_internal*`) are not exposed in the Settings UI. Set them via DevTools: `chrome.storage.sync.set({ _internalUsePlannerFlow: true })`.

---

## Architecture decisions

| Decision | Rationale |
|----------|-----------|
| Direct API calls (no backend) | Zero infrastructure for MVP; keys stay in `chrome.storage.sync` |
| Vanilla JS, no framework | No build step; fast reload; small bundle; readable at this scale |
| Two-model architecture | LLM1 is ~100× cheaper than LLM2; routing cost is negligible vs savings |
| LLM1 makes binary decision only | Choosing DOM vs screenshot is deterministic (cheapest wins); letting LLM1 pick tools introduced quality-over-cost bias |
| Planner receives only metadata | No raw text = no prompt-injection surface; compact input fits the nano model's context window |
| History text-only (strip images) | Avoids 10–20× token inflation from repeating screenshots across turns |
| DOM enriched back into history | LLM2 sees prior DOM content in subsequent turns without re-gathering |
| `domReliable` hard gate | PDF/canvas pages are blind to change signals — legacy flow is safer and costs the same |
| Shadow flow doubles cost | True cost comparison requires a real call; gated behind a dev-only toggle |
| `chrome.storage.sync` for keys | Roams with Chrome profile; acceptable for personal use |
