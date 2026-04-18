/**
 * Builds the system prompt and user message content sent to Claude.
 * Handles screenshot compression via canvas (runs in side-panel context).
 */

export const SYSTEM_PROMPT = `You are AutoGlance, an intelligent AI browser assistant built into Chrome. You help users understand and interact with the web pages they're browsing.

When a screenshot of the user's current browser tab is provided, use it as your primary source of visual context. You can:
- Describe what's on screen and help users understand interfaces
- Find buttons, links, or UI elements the user is looking for
- Summarize articles, dashboards, or data-heavy pages
- Explain errors or warnings visible on screen
- Compare products, prices, or content visible in the viewport
- Answer questions about charts, graphs, or visual data
- Help debug UI issues

Guidelines:
- Always respond in the same language the user writes in. If the user writes in Hebrew, respond in Hebrew. If in English, respond in English.
- Be concise and direct. Lead with the answer, then explain if needed.
- Reference specific visible elements when relevant ("the blue Download button in the top right")
- If no screenshot is provided, answer based on the URL and page title context given
- If the page is a sensitive/private domain, work from text context only
- Keep responses focused and scannable - use short paragraphs or lists when helpful
- Acknowledge uncertainty when you can't clearly see something in the screenshot

Math formatting:
- Always wrap display math (equations, matrices, multi-line expressions) in \[ … \] or $$ … $$
- Always wrap inline math in \( … \) or $ … $
- Never output raw LaTeX without delimiters - it will not render`;

/**
 * Compress a screenshot dataURL to a smaller JPEG using an offscreen canvas.
 * Returns the base64-encoded JPEG data (without the data: prefix).
 *
 * @param {string} dataUrl - Original dataURL from captureVisibleTab
 * @param {number} maxWidth - Max width in pixels
 * @param {number} quality - JPEG quality 0-1
 * @returns {Promise<string>} base64 JPEG data
 */
export async function compressScreenshot(dataUrl, maxWidth = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let { width, height } = img;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const compressed = canvas.toDataURL('image/jpeg', quality);
      // Strip the "data:image/jpeg;base64," prefix
      resolve(compressed.split(',')[1]);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * Build the text portion of the user's message, injecting page metadata.
 *
 * @param {string} userText - Raw user input
 * @param {object|null} pageContext - { url, title, selectedText, timestamp }
 * @param {boolean} hasScreenshot - Whether a screenshot is attached
 * @returns {string}
 */
export function buildUserText(userText, pageContext, hasScreenshot) {
  const parts = [];

  if (pageContext) {
    const meta = [];
    if (pageContext.title) meta.push(`Page: ${pageContext.title}`);
    if (pageContext.url) meta.push(`URL: ${pageContext.url}`);
    if (pageContext.selectedText?.trim()) {
      meta.push(`Selected text: "${pageContext.selectedText.trim().slice(0, 500)}"`);
    }
    if (!hasScreenshot) {
      meta.push('(No screenshot - text context only)');
    }
    if (meta.length) {
      parts.push(`[Browser Context]\n${meta.join('\n')}`);
    }
  }

  parts.push(userText);
  return parts.join('\n\n');
}

/**
 * Prepare conversation history for any provider's API.
 * Returns text-only entries - images are never replayed in history to save tokens.
 *
 * @param {Array<{role: string, textContent: string}>} history
 * @returns {Array<{role: string, textContent: string}>}
 */
export function prepareHistory(history) {
  return history.map((msg) => ({
    role: msg.role,
    textContent: msg.textContent,
  }));
}
