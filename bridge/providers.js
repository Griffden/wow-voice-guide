'use strict';

const DEFAULT_SYSTEM = [
  'You are a concise in-game World of Warcraft quest and gameplay guide.',
  'Answer the player directly. Prefer actionable directions and mention landmarks.',
  'Never invent an exact coordinate. Include a waypoint only when the supplied context or a trusted tool result contains that coordinate.',
  'Return only JSON with this shape:',
  '{"display":"answer shown in game","speech":"natural answer to speak","waypoint":{"mapId":123,"x":0.45,"y":0.67,"label":"place"}}',
  'The waypoint property is optional. x and y are normalized from 0 to 1.',
].join('\n');

function secret(envName, configured) {
  return process.env[envName] || configured || '';
}

function withTimeout(ms, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return Promise.resolve(fn(controller.signal)).finally(() => clearTimeout(timer));
}

function stripFence(text) {
  const s = String(text || '').trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : s;
}

function normalizeWaypoint(value) {
  if (!value || typeof value !== 'object') return null;
  const mapId = Number(value.mapId);
  let x = Number(value.x), y = Number(value.y);
  if (x > 1 && x <= 100) x /= 100;
  if (y > 1 && y <= 100) y /= 100;
  if (!Number.isInteger(mapId) || mapId <= 0 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { mapId, x, y, label: String(value.label || '').slice(0, 120) };
}

function normalizeAssistantResponse(raw) {
  const original = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  let value = raw;
  if (typeof raw === 'string') {
    const clean = stripFence(raw);
    try { value = JSON.parse(clean); }
    catch {
      const first = clean.indexOf('{'), last = clean.lastIndexOf('}');
      if (first >= 0 && last > first) {
        try { value = JSON.parse(clean.slice(first, last + 1)); } catch { value = null; }
      } else value = null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const text = String(original || '').trim() || 'I could not produce an answer.';
    return { display: text, speech: text, waypoint: null };
  }
  const display = String(value.display || value.text || value.answer || value.speech || '').trim();
  const speech = String(value.speech || display).trim();
  return {
    display: display || speech || 'I could not produce an answer.',
    speech: speech || display || 'I could not produce an answer.',
    waypoint: normalizeWaypoint(value.waypoint),
  };
}

function buildMessages({ context, history, text }) {
  const system = context ? `${DEFAULT_SYSTEM}\n\nCurrent game context:\n${context}` : DEFAULT_SYSTEM;
  const prior = (history || []).slice(-12).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.text || '').slice(0, 4000),
  }));
  return [{ role: 'system', content: system }, ...prior, { role: 'user', content: String(text || '') }];
}

async function requestAssistant(cfg, input) {
  const llm = cfg.llm || {};
  if (llm.provider === 'gemini') return requestGemini(cfg, input);
  const endpoint = llm.endpoint || 'http://127.0.0.1:1234/v1/chat/completions';
  const model = llm.model || '';
  if (!model) throw new Error('No reasoning model is configured. Open companion settings and choose an LLM model.');
  const headers = { 'Content-Type': 'application/json' };
  const key = secret('WOWVOICE_LLM_API_KEY', llm.apiKey);
  if (key) headers.Authorization = `Bearer ${key}`;
  const body = {
    model,
    messages: buildMessages(input),
  };
  if (/^gpt-[56]/.test(model)) body.max_completion_tokens = llm.maxTokens || 500;
  else {
    body.max_tokens = llm.maxTokens || 500;
    body.temperature = llm.temperature ?? 0.2;
  }
  if (llm.reasoningEffort) body.reasoning_effort = llm.reasoningEffort;
  if (llm.responseFormat !== false) body.response_format = { type: 'json_object' };
  const response = await withTimeout(llm.timeoutMs || 45000, signal => fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  }));
  if (!response.ok) throw new Error(`Reasoning provider returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const json = await response.json();
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (typeof content !== 'string') throw new Error('Reasoning provider returned no assistant message.');
  return normalizeAssistantResponse(content);
}

async function requestGemini(cfg, input) {
  const llm = cfg.llm || {};
  const key = secret('GEMINI_API_KEY', llm.apiKey);
  if (!key) throw new Error('No Gemini API key is configured.');
  const model = llm.model || 'gemma-4-26b-a4b-it';
  const messages = buildMessages(input);
  const system = messages.shift().content;
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await withTimeout(llm.timeoutMs || 45000, signal => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        temperature: llm.temperature ?? 0.2,
        maxOutputTokens: llm.maxTokens || 500,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: llm.thinkingLevel || 'minimal' },
      },
    }),
    signal,
  }));
  if (!response.ok) throw new Error(`Gemini provider returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const json = await response.json();
  const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
  const content = Array.isArray(parts) ? parts.map(p => p.text || '').join('') : '';
  if (!content) throw new Error('Gemini provider returned no assistant message.');
  return normalizeAssistantResponse(content);
}

async function requestFishSpeech(cfg, text) {
  const fish = cfg.fish || {};
  const key = secret('FISH_API_KEY', fish.apiKey);
  if (!key) throw new Error('No Fish Audio API key is configured.');
  if (!fish.voiceId) throw new Error('No Fish Audio voice model ID is configured.');
  const body = {
    text: String(text || '').slice(0, 5000),
    reference_id: fish.voiceId,
    format: 'wav',
    sample_rate: 44100,
    latency: fish.latency || 'balanced',
    normalize: true,
    prosody: { speed: fish.speed || 1, volume: fish.volume || 0, normalize_loudness: true },
  };
  const response = await withTimeout(fish.timeoutMs || 60000, signal => fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      model: fish.model || 's2.1-pro-free',
    },
    body: JSON.stringify(body),
    signal,
  }));
  if (!response.ok) throw new Error(`Fish Audio returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return Buffer.from(await response.arrayBuffer());
}

function redact(value) {
  let text = String(value ?? '');
  for (const key of ['DEEPGRAM_API_KEY', 'FISH_API_KEY', 'WOWVOICE_LLM_API_KEY', 'GEMINI_API_KEY']) {
    if (process.env[key]) text = text.split(process.env[key]).join('[redacted]');
  }
  text = text.replace(/(apiKey\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
  text = text.replace(/(Authorization:\s*(?:Bearer|Token)\s+)[^\s]+/gi, '$1[redacted]');
  return text;
}

module.exports = {
  DEFAULT_SYSTEM,
  buildMessages,
  normalizeAssistantResponse,
  normalizeWaypoint,
  redact,
  requestAssistant,
  requestGemini,
  requestFishSpeech,
};
