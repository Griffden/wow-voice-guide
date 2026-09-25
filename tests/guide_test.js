'use strict';
// Player guide: quest-log lookups, Wowhead tool calls, labeled answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const Providers = require('../bridge/providers');
const WowData = require('../bridge/wowdata');

const OPENAI = { llm: { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'test-key' } };
const LOG = 'Location: Stormwind City - Trade District\nPosition: 60.0, 70.0 (map 1453)\nQuest log (2): Mirror Lake (#1861); For Love Eternal (#963)';

const WOWHEAD = {
  'https://nether.wowhead.com/forever/tooltip/quest/1861': { name: 'Mirror Lake', tooltip: '<table><tr><td><b>Mirror Lake</b></td></tr></table><table><tr><td><br />Bring a Mirror Lake sample to Jennea Cannon in Stormwind.<br /><br /><span>Requirements:</span><br /> - Mirror Lake Water Sample</td></tr></table>' },
  'https://www.wowhead.com/forever/search/suggestions-template?q=Mirror%20Lake': { results: [
    { type: 5, id: 1861, name: 'Mirror Lake', typeName: 'Quest', side: 1, pinFooterText: 'Level: 10', pinBreadcrumb: ['Classes', 'Mage'], pinDescription: 'Go to the base of the waterfall at Mirror Lake, southwest of the Stormwind gates.' },
  ] },
  'https://nether.wowhead.com/forever/tooltip/npc/2439': { name: 'Major Samuelson', tooltip: '<table><tr><td>Major Samuelson</td></tr><tr><td>Stormwind City Guard</td></tr></table>', map: { zone: 1519, coords: { 0: [[72.4, 16]] } } },
};

// Serves Wowhead JSON from the table above and OpenAI responses in order.
function fakeNetwork(responses) {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.openai.com/')) {
      requests.push(JSON.parse(init.body));
      const next = responses.shift();
      if (!next) throw new Error('unexpected model request');
      return new Response(JSON.stringify({ output: next }), { status: 200 });
    }
    return new Response(JSON.stringify(WOWHEAD[url] || { error: 'Entity not found' }), { status: 200 });
  };
  return { requests, restore: () => { global.fetch = originalFetch; WowData._cache.clear(); } };
}

const say = value => [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] }];

test('a quest from the log is looked up before the model runs, and the answer cites it', async () => {
  const net = fakeNetwork([say({ speech: 'Go to the base of the waterfall at Mirror Lake, southwest of the Stormwind gates.', basis: 'forever' })]);
  const progress = [];
  try {
    const answer = await Providers.requestGuideAnswer(OPENAI, { context: LOG, text: 'Where can I find the Mirror Lake water sample?', onProgress: t => progress.push(t) });
    assert.equal(net.requests.length, 1);
    const prompt = net.requests[0].input[0].content;
    assert.match(prompt, /Wowhead Forever reference[\s\S]*Quest 1861 "Mirror Lake", level 10/);
    assert.match(prompt, /Bring a Mirror Lake sample to Jennea Cannon/);
    assert.match(prompt, /base of the waterfall/);
    assert.deepEqual(net.requests[0].tools.map(t => t.name || t.type), ['web_search', 'wowhead_search', 'wowhead_lookup']);
    assert.equal(net.requests[0].tool_choice, 'auto');
    assert.equal(net.requests[0].store, false);
    assert.match(net.requests[0].instructions, /instead of refusing/);
    assert.match(answer.speech, /^Go to the base of the waterfall/, 'Forever-backed answers carry no caveat');
    assert.deepEqual(answer.sources, [{ title: 'Mirror Lake - Wowhead Forever', url: 'https://www.wowhead.com/forever/quest=1861' }]);
    assert.match(answer.display, /Sources: \[1\] Mirror Lake - Wowhead Forever/);
    assert.equal(answer.lookup.basis, 'forever');
    assert.equal(answer.lookup.questNotes, 1);
    assert.match(progress[0], /Looking up your quest/);
  } finally { net.restore(); }
});

test('the model can call the Wowhead tools and gets a waypoint from NPC coordinates', async () => {
  const net = fakeNetwork([
    [{ type: 'function_call', call_id: 'c1', name: 'wowhead_lookup', arguments: '{"type":"npc","id":2439}' }],
    say({ speech: 'Major Samuelson is in Stormwind Keep.', basis: 'forever',
      waypoint: { zone: 'Stormwind City', x: 72.4, y: 16, label: 'Major Samuelson', sourceUrl: 'https://www.wowhead.com/forever/npc=2439' } }),
  ]);
  const progress = [];
  try {
    const answer = await Providers.requestGuideAnswer(OPENAI, { context: 'Location: Elwynn Forest\nPosition: 40.0, 60.0 (map 1429)', text: 'Where is Major Samuelson?', onProgress: t => progress.push(t) });
    assert.equal(net.requests.length, 2);
    const second = net.requests[1].input;
    assert.equal(second[1].type, 'function_call');
    const result = second.find(item => item.type === 'function_call_output');
    assert.equal(result.call_id, 'c1');
    assert.deepEqual(JSON.parse(result.output).location, { zone: 'Stormwind City', uiMapId: 1453, coords: [[72.4, 16]] });
    assert.equal(answer.waypoint.mapId, 1453);
    assert.equal(answer.waypoint.label, 'Major Samuelson');
    assert.deepEqual(answer.sources, [{ title: 'Major Samuelson - Wowhead Forever', url: 'https://www.wowhead.com/forever/npc=2439' }]);
    assert.equal(answer.lookup.toolCalls, 1);
    assert.ok(progress.some(t => /Looking up npc 2439/.test(t)));
  } finally { net.restore(); }
});

test('tool errors go back to the model instead of failing the answer', async () => {
  const net = fakeNetwork([
    [{ type: 'function_call', call_id: 'c1', name: 'wowhead_lookup', arguments: '{"type":"quest","id":424242}' }],
    say({ speech: 'Check its objective in your quest log.', basis: 'general' }),
  ]);
  try {
    const answer = await Providers.requestGuideAnswer(OPENAI, { context: '', text: 'What is quest 424242?' });
    const output = net.requests[1].input.find(item => item.type === 'function_call_output');
    assert.match(JSON.parse(output.output).error, /no Forever entry for quest 424242/);
    assert.match(answer.speech, /^I couldn't confirm this for Forever/);
  } finally { net.restore(); }
});

test('Classic and general answers are labeled; game-context answers are not', async () => {
  const net = fakeNetwork([
    [{ type: 'web_search_call', action: { type: 'search', sources: [{ url: 'https://www.wowhead.com/classic/quest=963' }] } },
      { type: 'message', content: [{ type: 'output_text', text: '{"speech":"Kill Anaya in the Ameth\'Aran ruins.","basis":"classic"}',
        annotations: [{ type: 'url_citation', title: 'For Love Eternal - Classic', url: 'https://www.wowhead.com/classic/quest=963' }] }] }],
    say({ speech: 'Rut\'theran Village has the boat.', basis: 'general' }),
    say({ speech: 'Your character is Griffden, level 15.', basis: 'game' }),
  ]);
  try {
    const classic = await Providers.requestGuideAnswer(OPENAI, { context: '', text: 'How do I do the Anaya quest?' });
    assert.match(classic.speech, /^Based on Classic info, which may differ in Forever: Kill Anaya/);
    assert.equal(classic.sources[0].url, 'https://www.wowhead.com/classic/quest=963');
    const general = await Providers.requestGuideAnswer(OPENAI, { context: '', text: 'Where is the boat?' });
    assert.match(general.speech, /^I couldn't confirm this for Forever, so this is from general WoW knowledge: Rut'theran/);
    const game = await Providers.requestGuideAnswer(OPENAI, { context: 'Character: Griffden, level 15', text: 'What is my name?' });
    assert.equal(game.speech, 'Your character is Griffden, level 15.');
    assert.equal(game.display, 'Your character is Griffden, level 15.');
    assert.deepEqual(game.sources, []);
  } finally { net.restore(); }
});

test('a Forever claim with nothing looked up is labeled as general knowledge', async () => {
  const net = fakeNetwork([say({ speech: 'Bolvar is in the Keep.', basis: 'forever' })]);
  try {
    const answer = await Providers.requestGuideAnswer(OPENAI, { context: '', text: 'Where is Bolvar?' });
    assert.equal(answer.lookup.basis, 'general');
    assert.match(answer.speech, /^I couldn't confirm this for Forever/);
  } finally { net.restore(); }
});

test('an explicit Classic question gets its Classic answer without the Forever caveat', async () => {
  const net = fakeNetwork([[{ type: 'web_search_call' }, ...say({ speech: 'Classic route.', basis: 'classic' })]]);
  try {
    const answer = await Providers.requestGuideAnswer(OPENAI, { context: '', text: 'I mean WoW Classic, not Forever: where is Mirror Lake?' });
    assert.equal(answer.speech, 'Classic route.');
  } finally { net.restore(); }
});

test('an uncited or unmatched waypoint is dropped', async () => {
  const net = fakeNetwork([say({ speech: 'Booty Bay is south in Stranglethorn Vale.', basis: 'general',
    waypoint: { zone: 'Stranglethorn Vale', x: 27, y: 77, label: 'Booty Bay', sourceUrl: 'https://unrelated.example/coords' } })]);
  try {
    const answer = await Providers.requestGuideAnswer(OPENAI, { context: '', text: 'How do I get to Booty Bay?' });
    assert.equal(answer.waypoint, null);
  } finally { net.restore(); }
});

test('the last round forbids further tool calls so the player always gets an answer', async () => {
  const call = n => [{ type: 'function_call', call_id: `c${n}`, name: 'wowhead_search', arguments: '{"query":"Mirror Lake"}' }];
  const net = fakeNetwork([call(1), call(2), say({ speech: 'Head to the waterfall at Mirror Lake.', basis: 'forever' })]);
  try {
    const answer = await Providers.requestGuideAnswer({ ...OPENAI, playerGuide: { maxRounds: 3 } }, { context: '', text: 'Where is it?' });
    assert.deepEqual(net.requests.map(r => r.tool_choice), ['auto', 'auto', 'none']);
    assert.equal(answer.lookup.basis, 'forever');
    assert.equal(answer.sources[0].url, 'https://www.wowhead.com/forever/quest=1861', 'a search hit the answer names backs it');
  } finally { net.restore(); }
});

test('search hits the answer does not name are not shown as sources', async () => {
  const net = fakeNetwork([
    [{ type: 'function_call', call_id: 'c1', name: 'wowhead_search', arguments: '{"query":"Mirror Lake"}' }],
    say({ speech: 'Talk to the quest givers near the central tree.', basis: 'forever' }),
  ]);
  try {
    const answer = await Providers.requestGuideAnswer(OPENAI, { context: '', text: 'What should I pick up here?' });
    assert.deepEqual(answer.sources, []);
  } finally { net.restore(); }
});

test('a looked-up NPC the answer names becomes a waypoint even if the model omits one', async () => {
  const net = fakeNetwork([
    [{ type: 'function_call', call_id: 'c1', name: 'wowhead_lookup', arguments: '{"type":"npc","id":2439}' }],
    say({ speech: 'Major Samuelson stands in Stormwind Keep, around 72, 16.', basis: 'forever' }),
  ]);
  try {
    const answer = await Providers.requestGuideAnswer(OPENAI, { context: '', text: 'Where is he?' });
    assert.equal(answer.waypoint.mapId, 1453);
    assert.equal(answer.waypoint.label, 'Major Samuelson');
  } finally { net.restore(); }
});

test('non-OpenAI presets still get the quest-log lookup in their prompt', async () => {
  const originalFetch = global.fetch;
  let chat;
  global.fetch = async (url, init = {}) => {
    if (String(url).startsWith('http://127.0.0.1')) {
      chat = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"display":"Find the waterfall.","speech":"Find the waterfall.","basis":"forever"}' } }] }), { status: 200 });
    }
    return new Response(JSON.stringify(WOWHEAD[url] || { error: 'Entity not found' }), { status: 200 });
  };
  try {
    const answer = await Providers.requestGuideAnswer({ llm: { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local' } },
      { context: LOG, history: [], text: 'How do I finish Mirror Lake?' });
    assert.match(chat.messages[0].content, /Wowhead Forever reference[\s\S]*Jennea Cannon/);
    assert.equal(answer.speech, 'Find the waterfall.');
    assert.match(answer.display, /Sources: \[1\] Mirror Lake - Wowhead Forever/);
  } finally { global.fetch = originalFetch; WowData._cache.clear(); }
});

test('playerGuide false skips lookups entirely', async () => {
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async url => {
    urls.push(String(url));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"speech":"Okay.","basis":"game"}' } }] }), { status: 200 });
  };
  try {
    await Providers.requestGuideAnswer({ llm: { ...OPENAI.llm, model: 'gpt-6-luna' }, playerGuide: false }, { context: LOG, history: [], text: 'Mirror Lake?' });
    assert.deepEqual(urls, ['https://api.openai.com/v1/chat/completions']);
  } finally { global.fetch = originalFetch; }
});
