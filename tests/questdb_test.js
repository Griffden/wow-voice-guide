'use strict';
// The offline Forever quest database: the ATT converter (tools/att-parser.js),
// the nearby-quest filters (bridge/questdb.js), and the guide tools using them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ATT = require('../tools/att-parser');
const Build = require('../tools/build-quest-db');
const QuestDB = require('../bridge/questdb');
const G = require('../bridge/gamestate');
const Providers = require('../bridge/providers');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'att-teldrassil.lua'), 'utf8');
const CONSTANTS = 'MAP = {\n\tKALIMDOR = 1414;\n\tTELDRASSIL = 1438;\n\tDARKSHORE = 1439;\n};\nSHADOWGLEN = 460;';
const MAPS = new Set([1414, 1438, 1439]);

function convert() {
  const env = ATT.loadConstants([CONSTANTS]);
  const found = ATT.questsFromFile(ATT.parseFile(FIXTURE, env), { file: 'zones/kalimdor/teldrassil.lua', maps: MAPS });
  const byId = {};
  for (const q of found.quests) byId[q.id] = q;
  return { byId, npcs: found.npcs };
}

test('ATT preprocessor keeps the Forever branches: ANYCLASSIC on, Season of Discovery off, BEFORE/AFTER against 1.60.1', () => {
  assert.equal(ATT.evalCondition('ANYCLASSIC'), true);
  assert.equal(ATT.evalCondition('SEASON_OF_DISCOVERY'), false);
  assert.equal(ATT.evalCondition('NOT SEASON_OF_DISCOVERY'), true);
  assert.equal(ATT.evalCondition('BEFORE 4.0.3'), true);
  assert.equal(ATT.evalCondition('AFTER TBC'), false);
  assert.equal(ATT.evalCondition('AFTER 1.15.3'), true);
  assert.equal(ATT.preprocess('a\n-- #if SEASON_OF_DISCOVERY\nb\n-- #elseif AFTER CATA\nc\n-- #else\nd\n-- #endif\ne'), 'a\n\n\n\n\n\nd\n\ne');
  assert.equal(ATT.inTimeline({ arr: [{ name: 'REMOVED_4_0_3' }] }), true, 'removed after Forever\'s version: still there');
  assert.equal(ATT.inTimeline({ arr: [{ name: 'REMOVED_1_15_3' }] }), false);
  assert.equal(ATT.inTimeline({ arr: [{ name: 'ADDED_4_0_3' }] }), false);
  assert.equal(ATT.inTimeline({ arr: [{ name: 'REMOVED_5_0_4' }, { name: 'ADDED_10_1_7' }] }), true);
  assert.equal(ATT.inTimeline({ arr: ['added 1.60.1.69893'] }), true);
});

test('ATT quest entries convert: names from comments, givers with coordinates, limits, prerequisites, timelines', () => {
  const { byId, npcs } = convert();
  assert.deepEqual(Object.keys(byId).map(Number).sort((a, b) => a - b), [1470, 1758, 1801, 2159, 3519, 4495, 5622, 9998, 9999]);
  assert.deepEqual(Build.compact(byId[3519]), { n: 'A Friend in Need', l: 2, f: 'A', pre: [4495], g: [[8584, 54.6, 33, 1438]] });
  assert.equal(npcs[8584], 'Iverron');
  assert.equal(npcs[3595], 'Shanda <Priest Trainer>');
  assert.deepEqual(Build.compact(byId[5622]), { n: 'In Favor of Elune', l: 5, f: 'A', r: ['NIGHTELF'], c: ['PRIEST'], b: 1, g: [[3595, 59.2, 40.4, 1438]] });
  assert.equal(byId[9999].present, false, 'removed before Forever');
  assert.deepEqual(byId[9998].givers, [[3, 50, 50, 1438]], 'the non-SoD branch, and a local constant for the coordinates');
  assert.deepEqual(byId[2159].givers, [[6780, 61.2, 47.6, 1438], [6781, 70, 20, 1439]], 'qgs pair with coords');
  assert.equal(byId[2159].lvl, 4);
  assert.equal(byId[2159].present, true, 'added in 1.15.3 by the bubbleDown around it');
  assert.deepEqual(Build.compact(byId[1758]), { n: 'Tome of the Cabal (A)', f: 'A', pre: [1798, 1799], pn: 1, m: [1438] });
  assert.equal(byId[1801].faction, 'H');
  assert.deepEqual(byId[1470].classes, ['WARLOCK'], 'class headers limit their quests');
  assert.deepEqual(byId[1470].givers, [[459]], 'coordinates on a map Forever does not have are dropped');
});

// A small database in the shipped format.
const DB = {
  meta: { license: 'MIT' },
  maps: { 1429: 'Elwynn Forest', 1438: 'Teldrassil' },
  npcs: { 1: 'Marshal Dughan', 2: 'Remy', 3: 'Priest Trainer', 4: 'Far Away', 5: 'Kobold Hater' },
  quests: {
    10: { n: 'Wolves Across the Border', l: 2, f: 'A', g: [[1, 42.1, 65.9, 1429]] },
    11: { n: 'Further Concerns', l: 5, f: 'A', pre: [10], g: [[1, 42.1, 65.9, 1429]] },
    12: { n: 'Priestly Business', l: 5, c: ['PRIEST'], g: [[3, 43, 65, 1429]] },
    13: { n: 'Horde Business', f: 'H', g: [[2, 43, 66, 1429]] },
    14: { n: 'Too Hard', l: 30, g: [[2, 43, 66, 1429]] },
    15: { n: 'Kobold Candles', l: 3, g: [[5, 47.5, 60.1, 1429]] },
    16: { n: 'Far Quest', l: 4, g: [[4, 80, 20, 1429]], old: 1 },
    17: { n: 'Winter Veil Gift', ev: 'Winter Veil', g: [[1, 42, 66, 1429]] },
    18: { n: 'In My Log', g: [[1, 42, 66, 1429]] },
    19: { n: 'Somewhere Else', g: [[1, 50, 50, 1438]] },
    20: { n: 'Done Already', g: [[1, 42, 66, 1429]] },
  },
};

const PLAYER = { level: 6, race: 'Human', class: 'Hunter', faction: 'Alliance', mapId: 1429, x: 42, y: 66 };

test('quests near me: eligible quests on the player\'s map, nearest first, with direction', () => {
  QuestDB.use(DB);
  const near = QuestDB.questsNear({ player: PLAYER, completed: new Set([10, 20]), active: new Set([18]) });
  assert.equal(near.zone, 'Elwynn Forest');
  assert.deepEqual(near.quests.map(q => q.id), [11, 15, 16], 'faction, class, level, event, completed and active quests filtered');
  assert.deepEqual(near.quests[0], { id: 11, name: 'Further Concerns', minLevel: 5, giver: 'Marshal Dughan', x: 42.1, y: 65.9, zone: 'Elwynn Forest', distance: 0.1, direction: 'north-east', url: 'https://www.wowhead.com/forever/quest=11' });
  assert.equal(near.quests[1].direction, 'north-east');
  assert.equal(near.quests[2].unverified, true);
  assert.equal(near.note, undefined);
  // Without the completed list, prerequisites can't be checked: say so.
  const unknown = QuestDB.questsNear({ player: PLAYER });
  assert.ok(unknown.quests.some(q => q.id === 11 && q.mayNeed[0] === 'Wolves Across the Border (#10)'));
  assert.match(unknown.note, /Completed quests are unknown/);
  // A prerequisite not yet done hides the follow-up.
  assert.ok(!QuestDB.questsNear({ player: PLAYER, completed: new Set([20]) }).quests.some(q => q.id === 11));
  // Another zone by map id.
  assert.deepEqual(QuestDB.questsNear({ player: PLAYER, mapId: 1438, completed: new Set([1]) }).quests.map(q => q.id), [19]);
  assert.equal(QuestDB.direction(0, -5), 'north');
  assert.equal(QuestDB.direction(-3, 3), 'south-west');
});

test('quest info by id or name, with giver coordinates and prerequisite status', () => {
  QuestDB.use(DB);
  const byId = QuestDB.questInfo('#11', { player: PLAYER, completed: new Set([10]) });
  assert.equal(byId.results.length, 1);
  assert.deepEqual(byId.results[0].givers, [{ npcId: 1, npc: 'Marshal Dughan', x: 42.1, y: 65.9, mapId: 1429, zone: 'Elwynn Forest' }]);
  assert.deepEqual(byId.results[0].prerequisites, [{ id: 10, name: 'Wolves Across the Border', done: true }]);
  assert.equal(byId.results[0].status, 'available');
  const byName = QuestDB.questInfo('kobold candles', { player: PLAYER });
  assert.equal(byName.results[0].id, 15);
  assert.equal(QuestDB.questInfo('horde business', { player: PLAYER }).results[0].status, 'Horde only');
  assert.match(QuestDB.questInfo('nothing like this', {}).note, /No quest/);
  assert.equal(QuestDB.locatedGivers(byId.results)[0].location.uiMapId, 1429);
});

test('zone summaries and prompt notes for presets without tools', () => {
  QuestDB.use(DB);
  assert.equal(QuestDB.zoneSummary({ player: PLAYER, completed: new Set([10, 20]), active: new Set([18]) }),
    'There are 3 quests you can pick up in Elwynn Forest. Nearest: Further Concerns from Marshal Dughan to the north-east, Kobold Candles from Kobold Hater to the north-east and Far Quest from Far Away to the north-east.');
  const notes = QuestDB.nearbyNotes({ player: PLAYER, completed: new Set([10, 20]) });
  assert.match(notes, /^Quests the player can pick up in Elwynn Forest/);
  assert.match(notes, /- Kobold Candles \(#15\), level 3\+: Kobold Hater at 47\.5, 60\.1, 8\.1 map units north-east/);
  assert.match(notes, /Far Quest .*unverified for Forever/);
  for (const q of ['What should I do next?', 'any quests around here', 'where can I find more quests']) assert.ok(QuestDB.asksForQuests(q), q);
  assert.ok(!QuestDB.asksForQuests('what level am I'));
});

function gameStore() {
  const s = G.newStore();
  G.applySections(s, G.encodeSections([
    ['char', 'Character: Testchar on Realm, level 6 Human Hunter (Alliance)'],
    ['loc', 'Location: Elwynn Forest\nPosition: 42.0, 66.0 (map 1429)'],
    ['quests', 'Quest log (1): In My Log (#18)'],
    ['done', '2 completed in 1 chunks'], ['done.1', 'a,a'],
  ]));
  return s;
}

test('Gemini and local presets get the nearby quests in their prompt when asked what to do', async () => {
  QuestDB.use(DB);
  const originalFetch = global.fetch;
  let body;
  global.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"display":"Talk to Marshal Dughan.","speech":"Talk to Marshal Dughan.","basis":"forever"}' } }] }), { status: 200 });
  };
  try {
    const answer = await Providers.requestGuideAnswer({ llm: { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local' } },
      { context: 'Location: Elwynn Forest', game: gameStore(), text: 'What should I do now?', history: [] });
    const system = body.messages[0].content;
    assert.match(system, /Quests the player can pick up in Elwynn Forest/);
    assert.match(system, /Further Concerns \(#11\)/);
    assert.doesNotMatch(system, /In My Log/, 'quests in the log are not offered again');
    assert.equal(answer.lookup.basis, 'forever', 'the database backs the answer');
    assert.equal(answer.sources[0].title, 'AllTheThings WoW: Forever quest data');
  } finally { global.fetch = originalFetch; }
});

test('the OpenAI guide calls quest_info and turns the giver\'s coordinates into a waypoint', async () => {
  QuestDB.use(DB);
  const originalFetch = global.fetch;
  const requests = [];
  const replies = [
    [{ type: 'function_call', name: 'quest_info', call_id: 'c1', arguments: JSON.stringify({ quest: 'Kobold Candles' }) }],
    [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ speech: 'Kobold Hater gives Kobold Candles, just north-east of you.', basis: 'forever' }), annotations: [] }] }],
  ];
  global.fetch = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ output: replies.shift() }), { status: 200 });
  };
  try {
    const answer = await Providers.requestGuideAnswer({ llm: { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'k' } },
      { context: 'Location: Elwynn Forest', game: gameStore(), text: 'Who gives Kobold Candles?' });
    const toolResult = JSON.parse(requests[1].input.find(i => i.type === 'function_call_output').output);
    assert.equal(toolResult.results[0].givers[0].npc, 'Kobold Hater');
    assert.deepEqual(answer.waypoint, { mapId: 1429, x: 0.475, y: 0.601, label: 'Kobold Hater' });
    assert.deepEqual(answer.sources.map(s => s.url), ['https://www.wowhead.com/forever/quest=15']);
  } finally { global.fetch = originalFetch; }
});

test('the shipped database loads and carries the ATT MIT notice', () => {
  const db = JSON.parse(fs.readFileSync(QuestDB.DB_FILE, 'utf8'));
  assert.equal(db.meta.license, 'MIT');
  assert.match(db.meta.notice, /Copyright \(c\) 2026 AllTheThings WoW Addon/);
  assert.ok(Object.keys(db.quests).length > 3000);
  assert.deepEqual(db.quests[3519].g[0], [8584, 54.6, 33, 1438]);
  assert.equal(db.npcs[8584], 'Iverron');
  assert.equal(db.maps[1438], 'Teldrassil');
  assert.ok(fs.statSync(QuestDB.DB_FILE).size < 1.5 * 1024 * 1024, 'small enough to ship with the companion');
});
