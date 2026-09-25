'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Providers = require('../bridge/providers');

test('normalizes JSON, fenced JSON, percentages and bad waypoints', () => {
  const answer = Providers.normalizeAssistantResponse('```json\n{"display":"Go north.","speech":"Head north.","waypoint":{"mapId":1431,"x":45.2,"y":67.8,"label":"Darkshire"}}\n```');
  assert.deepEqual(answer, {
    display: 'Go north.',
    speech: 'Head north.',
    waypoint: { mapId: 1431, x: 0.452, y: 0.6779999999999999, label: 'Darkshire' },
  });
  assert.equal(Providers.normalizeAssistantResponse('{"display":"Okay","waypoint":{"mapId":0,"x":2,"y":2}}').waypoint, null);
  assert.equal(Providers.normalizeAssistantResponse('plain answer').display, 'plain answer');
});

test('buildMessages supplies game context, bounded history and the current question', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'claude' : 'user', text: `m${i}` }));
  const messages = Providers.buildMessages({ context: 'Quest: A Test', history, text: 'Where now?' });
  assert.ok(messages[0].content.includes('Quest: A Test'));
  assert.equal(messages.length, 14);
  assert.equal(messages[1].content, 'm8');
  assert.deepEqual(messages.at(-1), { role: 'user', content: 'Where now?' });
  assert.match(messages[0].content, /World of Warcraft: Forever/);
  assert.match(messages[0].content, /Do not silently substitute facts from Retail, Classic/);
  assert.match(messages[0].content, /earlier assistant replies as potentially mistaken/);
});

test('redact removes configured provider secrets', () => {
  const old = process.env.FISH_API_KEY;
  process.env.FISH_API_KEY = 'fish-secret-value';
  assert.equal(Providers.redact('Bearer fish-secret-value'), 'Bearer [redacted]');
  if (old === undefined) delete process.env.FISH_API_KEY; else process.env.FISH_API_KEY = old;
});

test('OpenAI-compatible request sends the selected low-latency model and parses structured output', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"display":"Turn left.","speech":"Take the next left."}' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const answer = await Providers.requestAssistant({ llm: {
      provider: 'openai-compatible', endpoint: 'https://example.test/v1/chat/completions', apiKey: 'test-key',
      model: 'gpt-6-luna', reasoningEffort: 'none', maxTokens: 123,
    } }, { context: 'Location: Duskwood', history: [], text: 'Where now?' });
    assert.equal(request.url, 'https://example.test/v1/chat/completions');
    assert.equal(request.init.headers.Authorization, 'Bearer test-key');
    assert.equal(request.body.model, 'gpt-6-luna');
    assert.equal(request.body.max_completion_tokens, 123);
    assert.equal(request.body.reasoning_effort, 'none');
    assert.equal(request.body.temperature, undefined, 'reasoning-family models do not receive an unsupported sampling parameter');
    assert.deepEqual(answer, { display: 'Turn left.', speech: 'Take the next left.', waypoint: null });
  } finally { global.fetch = originalFetch; }
});

test('Fish request uses the configured reference voice and returns WAV bytes', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 });
  };
  try {
    const audio = await Providers.requestFishSpeech({ fish: { apiKey: 'fish-key', voiceId: 'voice-123', model: 's2.1-pro-free', latency: 'low' } }, 'For the Horde!');
    assert.equal(request.url, 'https://api.fish.audio/v1/tts');
    assert.equal(request.init.headers.model, 's2.1-pro-free');
    assert.equal(request.body.reference_id, 'voice-123');
    assert.equal(request.body.format, 'wav');
    assert.equal(request.body.latency, 'low');
    assert.deepEqual([...audio], [82, 73, 70, 70]);
  } finally { global.fetch = originalFetch; }
});

test('quest lookup routes only research questions and returns cited guidance', async () => {
  const context = 'Selected quest: The Magical City of Dalaran (id 94946)\nObjective: Board the skycutter';
  assert.equal(Providers.shouldResearchQuest('Where do I go?', context), true);
  assert.equal(Providers.shouldResearchQuest('What quest am I on?', context), false);
  assert.equal(Providers.shouldResearchQuest('Where can I find Bolvar Fordragon in WoW?', ''), true);
  assert.equal(Providers.shouldResearchQuest('No, this is for the new WoW Forever quest', ''), true);
  assert.equal(Providers.shouldResearchQuest('Exploring the Alliance', 'Quest log (1): Exploring the Alliance (#94946)'), true);
  assert.equal(Providers.shouldResearchQuest('What level am I?', context), false);
  assert.equal(Providers.shouldResearchQuest('Tell me a joke', context), false);
  assert.equal(Providers.shouldResearchQuest('How do I finish this quest?', ''), true);
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, init) => {
    request = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ output: [
      { type: 'web_search_call' },
      { type: 'message', content: [{ type: 'output_text', text: 'Board the ship near the dock. citeturn1search0', annotations: [
        { type: 'url_citation', title: 'WoW Forever quest notes', url: 'https://example.com/forever/quest=94946' },
      ] }] },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const answer = await Providers.requestPlayerGuide({ llm: { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'test-key' } }, { context, text: 'Where do I go?', history: [
      { role: 'user', text: 'I am doing the Forever Dalaran quest' },
      { role: 'claude', text: 'A previous mistaken NPC location' },
    ] });
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.deepEqual(request.body.tools, [{ type: 'web_search', external_web_access: true }]);
    assert.equal(request.body.tool_choice, 'required');
    assert.match(request.body.instructions, /World of Warcraft: Forever/);
    assert.match(request.body.instructions, /do not recycle those steps/);
    assert.match(request.body.input, /I am doing the Forever Dalaran quest/);
    assert.doesNotMatch(request.body.input, /A previous mistaken NPC location/);
    assert.equal(answer.speech, 'Board the ship near the dock.');
    assert.match(answer.display, /https:\/\/example\.com\/forever\/quest=94946/);
    assert.match(answer.display, /wowhead\.com\/forever\/quest=94946/);
    assert.deepEqual(answer.sources, [{ title: 'WoW Forever quest notes', url: 'https://example.com/forever/quest=94946' }]);
  } finally { global.fetch = originalFetch; }
});

test('a broad cited Forever guide is accepted when search also found the exact quest', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({ output: [
      { type: 'web_search_call', action: { type: 'search', sources: [
        { url: 'https://www.wowhead.com/forever/quest%3D1861/mirror-lake' },
      ] } },
      { type: 'message', content: [{ type: 'output_text', text: 'Use the flask at the lake waterfall.', annotations: [
        { type: 'url_citation', title: 'WoW Forever Human levelling guide', url: 'https://www.foreverwisp.com/guides/wow-forever-human-leveling-guide' },
      ] }] },
    ] }), { status: 200 });
  };
  try {
    const answer = await Providers.requestPlayerGuide({ llm: { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'test-key' } }, {
      context: 'Selected quest: An Unrelated Quest (id 90001)',
      text: 'Where is the Mirror Lake water sample for the Mirror Lake quest in WoW Forever?',
    });
    assert.doesNotMatch(request.input, /Focused quest:/, 'an unrelated tracked quest must not be substituted');
    assert.match(answer.speech, /lake waterfall/);
    assert.equal(answer.sources.length, 1);
    assert.equal(answer.lookup.topicSearchMatch, true);
    assert.doesNotMatch(answer.display, /quest=90001/);
  } finally { global.fetch = originalFetch; }
});

test('mentioning Classic or Forever keeps the current Forever edition', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ output: [
    { type: 'web_search_call' },
    { type: 'message', content: [{ type: 'output_text', text: 'Take the boat to Rut\'theran Village.', annotations: [
      { type: 'url_citation', title: 'WoW Forever travel from Darnassus to Auberdine', url: 'https://example.com/forever/darnassus-auberdine' },
    ] }] },
  ] }), { status: 200 });
  try {
    const answer = await Providers.requestPlayerGuide({ llm: { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'test-key' } }, {
      context: 'Game: World of Warcraft: Forever', text: 'In WoW Classic or WoW Forever, how do I travel from Darnassus to Auberdine?',
    });
    assert.equal(answer.lookup.edition, 'forever');
    assert.match(answer.speech, /Rut'theran Village/);
  } finally { global.fetch = originalFetch; }
});

test('guide withholds an answer backed only by an unrelated or wrong-edition citation', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ output: [
    { type: 'web_search_call' },
    { type: 'message', content: [{ type: 'output_text', text: 'Bolvar is in the Keep.', annotations: [
      { type: 'url_citation', title: 'Blackrock Depths', url: 'https://example.com/classic/blackrock-depths' },
    ] }] },
  ] }), { status: 200 });
  try {
    const answer = await Providers.requestPlayerGuide({ llm: { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'test-key' } }, {
      context: 'Game: World of Warcraft: Forever', text: 'Where can I find Bolvar Fordragon in WoW?',
    });
    assert.match(answer.speech, /couldn't verify a source/);
    assert.doesNotMatch(answer.speech, /in the Keep/);
    assert.deepEqual(answer.sources, []);
  } finally { global.fetch = originalFetch; }
});

test('an explicitly requested different edition is not treated as Forever', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.doesNotMatch(body.input, /Focused quest:/);
    return new Response(JSON.stringify({ output: [
      { type: 'web_search_call' },
      { type: 'message', content: [{ type: 'output_text', text: 'Classic-specific answer.', annotations: [
        { type: 'url_citation', title: 'Bolvar in WoW Classic', url: 'https://example.com/classic/bolvar' },
      ] }] },
    ] }), { status: 200 });
  };
  try {
    const answer = await Providers.requestPlayerGuide({ llm: { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'test-key' } }, {
      context: 'Selected quest: Forever quest (id 94946)', text: 'Where is Bolvar in WoW Classic?',
    });
    assert.equal(answer.speech, 'Classic-specific answer.');
    assert.equal(answer.sources.length, 1);
    assert.doesNotMatch(answer.display, /wowhead\.com\/forever/);
  } finally { global.fetch = originalFetch; }
});

test('an explicit not-Forever correction selects Classic', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ output: [
    { type: 'web_search_call' },
    { type: 'message', content: [{ type: 'output_text', text: 'Classic route.', annotations: [
      { type: 'url_citation', title: 'WoW Classic Mirror Lake', url: 'https://example.com/classic/mirror-lake' },
    ] }] },
  ] }), { status: 200 });
  try {
    const answer = await Providers.requestPlayerGuide({ llm: { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'test-key' } }, {
      context: 'Game: World of Warcraft: Forever', text: 'I mean WoW Classic, not Forever: where is Mirror Lake?',
    });
    assert.equal(answer.lookup.edition, 'classic');
    assert.equal(answer.speech, 'Classic route.');
  } finally { global.fetch = originalFetch; }
});

test('quest lookup never claims research if the API did not search', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Guess' }] }] }), { status: 200 });
  try {
    await assert.rejects(() => Providers.requestPlayerGuide({ llm: { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'test-key' } }, { text: 'Quest help' }), /did not search/);
  } finally { global.fetch = originalFetch; }
});
