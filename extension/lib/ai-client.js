/**
 * Multi-provider AI streaming client.
 * Supports Anthropic Claude, OpenAI, and Google Gemini.
 *
 * All providers expose the same interface through streamMessage().
 * Provider-specific message formatting is handled internally.
 */

const TIMEOUT_MS = 60_000;

/**
 * Stream an AI response. Dispatches to the appropriate provider.
 *
 * @param {object} opts
 * @param {'anthropic'|'openai'|'gemini'} opts.provider
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.systemPrompt
 * @param {Array<{role: string, textContent: string}>} opts.history  - text-only prior turns
 * @param {string} opts.userText      - text of the current user turn
 * @param {string|null} opts.screenshot - base64 JPEG or null
 * @param {function} opts.onChunk     - called with each text chunk string
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} full accumulated response text
 */
export async function streamMessage(opts) {
  const { provider = 'anthropic' } = opts;

  if (!opts.apiKey) {
    throw new Error(
      `No API key configured for ${provider}. Open Settings to add your key.`
    );
  }

  const withTimeout = addTimeout(opts.signal, TIMEOUT_MS);

  switch (provider) {
    case 'openai':  return streamOpenAI ({ ...opts, signal: withTimeout });
    case 'gemini':  return streamGemini ({ ...opts, signal: withTimeout });
    default:        return streamAnthropic({ ...opts, signal: withTimeout });
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────

async function streamAnthropic({ apiKey, model, systemPrompt, history, userText, screenshot, onChunk, signal }) {
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.textContent })),
    {
      role: 'user',
      content: screenshot
        ? [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot } },
            { type: 'text', text: userText },
          ]
        : userText,
    },
  ];

  const response = await fetchWithCheck('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 4096, stream: true, system: systemPrompt, messages }),
    signal,
  });

  return readSSE(response.body, (event) => {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return event.delta.text;
    }
  }, onChunk);
}

// ── OpenAI ────────────────────────────────────────────────────────────────

async function streamOpenAI({ apiKey, model, systemPrompt, history, userText, screenshot, onChunk, signal }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({
      role: m.role,  // 'user' | 'assistant' - already correct for OpenAI
      content: m.textContent,
    })),
    {
      role: 'user',
      content: screenshot
        ? [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}`, detail: 'high' } },
            { type: 'text', text: userText },
          ]
        : userText,
    },
  ];

  const response = await fetchWithCheck('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, stream: true, messages }),
    signal,
  });

  return readSSE(response.body, (event) => {
    // OpenAI sends [DONE] as a string, not JSON - the SSE reader handles that
    return event.choices?.[0]?.delta?.content ?? null;
  }, onChunk);
}

// ── Google Gemini ─────────────────────────────────────────────────────────

async function streamGemini({ apiKey, model, systemPrompt, history, userText, screenshot, onChunk, signal }) {
  // Gemini uses 'model' for the assistant role
  const contents = [
    ...history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.textContent }],
    })),
    {
      role: 'user',
      parts: [
        ...(screenshot ? [{ inlineData: { mimeType: 'image/jpeg', data: screenshot } }] : []),
        { text: userText },
      ],
    },
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const response = await fetchWithCheck(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 4096 },
    }),
    signal,
  });

  return readSSE(response.body, (event) => {
    // Gemini SSE: {candidates:[{content:{parts:[{text:"..."}]}}]}
    return event.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  }, onChunk);
}

// ── Shared SSE Reader ─────────────────────────────────────────────────────

/**
 * Reads an SSE stream, parses data lines, and calls extractor on each event.
 * extractor(parsedEvent) should return a text chunk string or null/undefined to skip.
 */
async function readSSE(stream, extractor, onChunk) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by \n\n
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;

        const json = dataLine.slice(6).trim();
        if (json === '[DONE]') continue;

        let parsed;
        try { parsed = JSON.parse(json); } catch { continue; }

        // Propagate API-level errors embedded in the stream
        const embeddedError = parsed.error?.message ?? parsed.candidates?.[0]?.finishReason === 'SAFETY'
          ? 'Response blocked by safety filter'
          : null;
        if (embeddedError) throw new Error(embeddedError);

        const chunk = extractor(parsed);
        if (chunk) {
          fullText += chunk;
          onChunk?.(chunk);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function fetchWithCheck(url, init) {
  const response = await fetch(url, init);

  if (!response.ok) {
    let msg = `API error ${response.status}`;
    try {
      const body = await response.json();
      msg = body?.error?.message ?? body?.error?.status ?? msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  return response;
}

/** Combine an optional external AbortSignal with an internal timeout. */
function addTimeout(externalSignal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), ms);

  const cleanup = () => clearTimeout(timer);
  controller.signal.addEventListener('abort', cleanup, { once: true });

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
    }
  }

  return controller.signal;
}
