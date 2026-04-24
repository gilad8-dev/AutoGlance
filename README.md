# AutoGlance

> AI browser copilot with visual page understanding

AutoGlance is a Chrome Extension (Manifest V3) that opens a side-panel chat inside Chrome. Every message you send can automatically include a screenshot of your current tab, giving the AI full visual context about what you're looking at.

---

## Features

- **Side-panel chat** - persistent, non-intrusive, always accessible
- **Automatic screenshot capture** - attaches the visible tab with each message
- **Streaming responses** - text streams in as Claude thinks
- **Privacy-first** - per-domain blocklist, one-click screenshot toggle, visual indicators
- **Markdown rendering** - code blocks, lists, bold/italic, and more
- **Conversation history** - multi-turn context sent with each message
- **Options page** - API key, model selection, quality settings, domain blocklist

---

## Setup

### 1. Generate Icons (one-time)

```bash
node scripts/generate-icons.js
```

This creates `extension/icons/icon{16,32,48,128}.png`. Requires Node.js (no npm packages needed).

### 2. Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder inside this project

The AutoGlance icon will appear in your Chrome toolbar.

### 3. Configure Your API Key

1. Click the AutoGlance icon in the toolbar (or right-click → **Options**)
2. Enter your **Anthropic API key** (get one at [console.anthropic.com](https://console.anthropic.com/settings/keys))
3. Choose your preferred Claude model
4. Click **Save Settings**

### 4. Open the Side Panel

- Click the **AutoGlance toolbar icon** to open the side panel
- The panel stays open as you browse - ask questions about any page

---

## Using AutoGlance

Type any question in the chat input. Examples:

| Prompt | What it does |
|--------|-------------|
| `What am I looking at?` | Describes the current page |
| `Summarize this article` | Summarizes visible content |
| `Where do I click to download?` | Locates the button/link |
| `Why is this page showing an error?` | Diagnoses visible errors |
| `Compare the pricing plans on screen` | Analyses visible data |
| `Explain this chart` | Interprets graphs/dashboards |

Press **Enter** to send, **Shift+Enter** for a newline.

---

## Privacy Controls

### Screenshot Toggle

Click the **camera icon** in the side-panel header to toggle automatic screenshot capture on/off. The privacy bar below the header shows the current state:

| Color | Meaning |
|-------|---------|
| 🟢 Green | Screenshot will be sent with your message |
| 🟡 Yellow | Current domain is in the blocklist - text only |
| ⚫ Gray | Screenshot capture manually disabled |

### Domain Blocklist

The following domains are blocked by default (no screenshots):

- `mail.google.com`, `outlook.live.com` - email
- `chase.com`, `bankofamerica.com`, `paypal.com`, etc. - banking/payments
- `healthcare.gov`, `adp.com`, `workday.com` - sensitive accounts

Add your own in **Settings → Blocked Domains**, one domain per line. Subdomains match automatically (`chase.com` also blocks `secure.chase.com`).

### What Is Sent to Anthropic

Each message may include:
- Your typed text
- The page title and URL of the current tab
- Any text you have selected on the page
- A JPEG screenshot of the visible viewport (if enabled and domain not blocked)

**Nothing is stored on any server.** Requests go directly from your browser to `api.anthropic.com`. Your API key is stored in `chrome.storage.sync` (local to your Chrome profile).

---

## Project Structure

```
AutoGlance/
├── extension/
│   ├── manifest.json          # MV3 extension manifest
│   ├── background/
│   │   └── service-worker.js  # Screenshot capture, tab info, message router
│   ├── sidepanel/
│   │   ├── index.html         # Side panel UI
│   │   ├── sidepanel.js       # Main application logic
│   │   └── sidepanel.css      # Styles
│   ├── options/
│   │   ├── options.html       # Settings page
│   │   ├── options.js         # Settings logic
│   │   └── options.css        # Settings styles
│   ├── lib/
│   │   ├── storage.js         # chrome.storage wrapper + defaults
│   │   ├── privacy-rules.js   # Domain blocklist logic
│   │   ├── context-builder.js # Prompt/context assembly + image compression
│   │   └── ai-client.js       # Anthropic streaming API client
│   └── icons/                 # Generated PNG icons
└── scripts/
    └── generate-icons.js      # Icon generator (no npm deps)
```

---

## Configuration Reference

All settings are in **Settings** (gear icon or right-click extension icon → Options):

| Setting | Default | Description |
|---------|---------|-------------|
| API Key | - | Your `sk-ant-…` Anthropic key |
| Model | `claude-opus-4-7` | Claude model to use |
| Screenshots | On | Auto-attach screenshot with messages |
| Image Quality | 70% | JPEG quality before sending (lower = cheaper) |
| Max Width | 1280 px | Screenshots wider than this are resized |
| Blocked Domains | (list) | Domains where screenshots are disabled |

---

## Architecture Notes

### Why direct API calls instead of a backend?

For an MVP, calling the Anthropic API directly from the extension page is simpler, requires no infrastructure, and is perfectly safe because the API key never leaves your browser (it's not bundled in the extension, it lives in `chrome.storage.sync` on your device).

A backend proxy would add value for: team key sharing, usage analytics, model routing, or hiding the key from the network tab. Add it later when needed.

### Why no React/Vue/Svelte?

Chrome extensions have very fast hot-reload cycles with plain HTML/CSS/JS. A framework would add a build step, larger bundle, and complexity without meaningful benefit for a focused side-panel UI. The codebase is small enough that vanilla JS is perfectly readable.

### Screenshot compression

`chrome.tabs.captureVisibleTab()` returns a raw PNG. The service worker returns it to the side panel where a `<canvas>` element redraws it at a capped resolution (default 1280 px) and re-encodes as JPEG at the configured quality level. This typically reduces a 2 MB+ PNG to ~150 KB before sending to the API.

### Conversation history and token management

Only the **current** user turn carries a screenshot. Historical turns are sent as text only. History is capped at 40 entries (~20 conversation pairs) to avoid excessive token costs.

---

## Future Improvements

- [ ] **Keyboard shortcut** to open/focus side panel
- [ ] **Copy code** buttons on code blocks
- [ ] **Message branching** - edit a past message and regenerate from that point
- [ ] **Session export** - save conversation as Markdown
- [ ] **Token usage display** - show estimated cost per message
- [ ] **Multiple screenshots** - let the user attach screenshots from different moments
- [ ] **DOM summarization** - extract semantic HTML structure as additional context
- [ ] **Backend proxy** - for team/enterprise use, shared API key management
- [ ] **Custom system prompt** - let power users define their own assistant persona
- [ ] **Offline detection** - graceful error when no internet connection

---

## Tradeoffs

| Decision | Rationale |
|----------|-----------|
| Direct API calls (no backend) | Simplicity and zero infrastructure for MVP |
| Vanilla JS (no framework) | No build step, fast iteration, smaller bundle |
| `<all_urls>` host permission | Required for `captureVisibleTab` on arbitrary pages |
| JPEG screenshots | 3–5× smaller than PNG with acceptable visual fidelity |
| History text-only (strip images) | Avoids 10–20× token inflation from repeating screenshots |
| `chrome.storage.sync` for API key | Roams with Chrome profile; not ideal for high-security environments |
