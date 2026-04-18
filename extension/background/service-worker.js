/**
 * AutoGlance Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  - Open the side panel when the toolbar icon is clicked
 *  - Capture visible tab screenshots (only possible from background context)
 *  - Retrieve page context (URL, title, selected text) via scripting API
 */

// Open side panel automatically when the extension icon is clicked.
// This lets the user toggle the panel without extra clicks.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// ── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'CAPTURE_SCREENSHOT':
      handleCaptureScreenshot(sendResponse);
      return true; // Keep port open for async response

    case 'GET_PAGE_CONTEXT':
      handleGetPageContext(sendResponse);
      return true;

    case 'GET_TAB_INFO':
      handleGetTabInfo(sendResponse);
      return true;

    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      sendResponse({ success: true });
      return false;
  }
});

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleCaptureScreenshot(sendResponse) {
  try {
    const tab = await getActiveTab();
    if (!tab) {
      sendResponse({ success: false, error: 'No active tab found' });
      return;
    }

    // captureVisibleTab requires tabs permission + host permission for the tab URL
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 70, // initial quality - side panel will re-compress to target size
    });

    sendResponse({ success: true, dataUrl });
  } catch (err) {
    console.warn('[AutoGlance] Screenshot failed:', err.message);
    sendResponse({ success: false, error: err.message });
  }
}

async function handleGetPageContext(sendResponse) {
  try {
    const tab = await getActiveTab();
    if (!tab) {
      sendResponse({ success: false, error: 'No active tab found' });
      return;
    }

    let selectedText = '';
    try {
      // Inject a minimal function to read the current selection
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection()?.toString()?.trim() ?? '',
      });
      selectedText = results?.[0]?.result ?? '';
    } catch {
      // Scripting fails on chrome:// pages, PDFs, etc. - that's fine.
    }

    sendResponse({
      success: true,
      context: {
        url: tab.url,
        title: tab.title,
        selectedText: selectedText.slice(0, 1000), // cap at 1000 chars
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function handleGetTabInfo(sendResponse) {
  try {
    const tab = await getActiveTab();
    sendResponse({
      success: !!tab,
      tab: tab ? { url: tab.url, title: tab.title, id: tab.id } : null,
    });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the active tab in the last-focused window. */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}
