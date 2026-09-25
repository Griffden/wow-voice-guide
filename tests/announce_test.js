'use strict';
// Spoken announcements on the bridge side: what is said for each moment, the
// switches, rate limits, waiting for the guide, and quest narration.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../bridge/announce');
const G = require('../bridge/gamestate');
const P = require('../bridge/protocol');
const QuestDB = require('../bridge/questdb');

const moment = fields => G.encodeSections(Object.entries(fields));

QuestDB.use({
  maps: { 1429: 'Elwynn Forest', 1436: 'Westfall' },
  npcs: { 1: 'Marshal Dughan', 2: 'Gryan Stoutmantle' },
  quests: {
    33: { n: 'Wolves Across the Border', l: 2, g: [[1, 42.1, 65.9, 1429]] },
    40: { n: 'The People\'s Militia', l: 14, g: [[2, 56.3, 47.5, 1436]] },
    41: { n: 'Westfall Stew', l: 10, g: [[2, 56, 30, 1436]] },
  },
});

function game() {
  const s = G.newStore();
  G.applySections(s, G.encodeSections([
    ['char', 'Character: Testchar on Realm, level 15 Human Warrior (Alliance)'],
    ['loc', 'Location: Westfall\nPosition: 56.0, 47.0 (map 1436)'],
  ]));
  return s;
}

test('the add-on flags parse: "a" moments and in-game switches; slot files carry the switches back', () => {
  assert.equal(P.parseFlags('a').announce, true);
  assert.deepEqual(P.parseFlags('ann=quest:1,zone:0,bogus:1').announceSet, { quest: true, zone: false });
  assert.equal(P.parseFlags('').announceSet, undefined);
  const lua = P.luaTable('WoWClaude_SlotData', [], { now: 1000, announce: { quest: true, zone: false } });
  assert.match(lua, /\n\tannounce = \{ quest = true, zone = false \},\n/);
  assert.deepEqual(A.settings({ announce: { quest: true, zone: 'yes' } }), { quest: true, level: false, zone: false, bags: false, narrate: false }, 'off unless switched on');
});

test('each moment becomes a short sentence from the game state and the quest database', () => {
  assert.equal(A.compose(A.fieldsOf(moment({ kind: 'quest', id: '33', title: 'Wolves Across the Border', next: 'Return to Marshal Dughan' }))),
    'Wolves Across the Border is ready to turn in. Return to Marshal Dughan.');
  assert.equal(A.compose(A.fieldsOf(moment({ kind: 'quest', id: '33', title: 'Wolves Across the Border', next: '' }))),
    'Wolves Across the Border is ready to turn in. The quest giver was Marshal Dughan, at 42, 66 in Elwynn Forest.');
  assert.equal(A.compose(A.fieldsOf(moment({ kind: 'level', level: '16', spells: 'Shield Block; Revenge; Mocking Blow' }))),
    'Level 16! New at your class trainer: Shield Block, Revenge and Mocking Blow.');
  assert.equal(A.compose(A.fieldsOf(moment({ kind: 'level', level: '17', spells: '' }))), 'Level 17!');
  assert.equal(A.compose(A.fieldsOf(moment({ kind: 'zone', zone: 'Westfall', map: '1436' })), { game: game() }),
    'Welcome to Westfall. There are 2 quests you can pick up in Westfall. Nearest: The People\'s Militia from Gryan Stoutmantle to the south-east and Westfall Stew from Gryan Stoutmantle to the north.');
  assert.equal(A.compose(A.fieldsOf(moment({ kind: 'bags', free: '1', total: '64' }))), 'Your bags are almost full: 1 free slot left.');
  assert.equal(A.compose(A.fieldsOf(moment({ kind: 'repair', percent: '12', slot: 'Chest' }))), 'Your gear needs repair: chest is at 12% durability.');
  assert.equal(A.compose(A.fieldsOf(moment({ kind: 'accept', title: 'Westfall Stew', text: 'Salma needs meat.', objectives: 'Bring 3 Stringy Vulture Meat' }))),
    'Westfall Stew. Salma needs meat. Bring 3 Stringy Vulture Meat.');
});

test('the announcer speaks only switched-on kinds, rate limits, waits for the guide, and speaks in order', async () => {
  let now = 1000, busy = true;
  const spoken = [];
  const cfg = { announce: { quest: true, level: true, zone: false, bags: true } };
  const announcer = new A.Announcer({ cfg, busy: () => busy, now: () => now, retryMs: 5, speak: async text => { spoken.push(text); } });
  assert.equal(announcer.handle(moment({ kind: 'zone', zone: 'Westfall' })), 'off');
  assert.equal(announcer.handle(moment({ kind: 'accept', title: 'X', text: 'Y' })), 'off', 'narration has its own switch');
  assert.equal(announcer.handle(moment({ kind: 'level', level: '16' })), 'queued');
  assert.equal(announcer.handle(moment({ kind: 'bags', free: '0' })), 'queued');
  assert.equal(announcer.handle(moment({ kind: 'repair', percent: '5', slot: 'Legs' })), 'queued', 'repair shares the bags switch');
  assert.equal(announcer.handle(moment({ kind: 'bags', free: '0' })), 'rate-limited');
  assert.equal(announcer.handle(moment({ bogus: '1' })), 'ignored');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(spoken, [], 'nothing while the guide is answering');
  busy = false;
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(spoken, ['Level 16!', 'Your bags are almost full: no free slots left.', 'Your gear needs repair: legs is at 5% durability.']);
  now += 11000;
  assert.equal(announcer.handle(moment({ kind: 'quest', id: '33', title: 'Wolves Across the Border' })), 'queued');
  announcer.stop();
});

test('"read me this quest" reads the focused quest from the game state', () => {
  assert.ok(A.asksToReadQuest('Read me this quest'));
  assert.ok(A.asksToReadQuest('can you read the quest text?'));
  assert.ok(!A.asksToReadQuest('where do I go for this quest'));
  const s = G.newStore();
  G.applySections(s, G.encodeSections([['quest', 'Tracked quest: Westfall Stew (id 41)\nObjective: 0/3 Stringy Vulture Meat\nQuest instructions: Bring 3 Stringy Vulture Meat\nQuest description: Salma needs meat for her stew.']]));
  assert.equal(A.questStory(s), 'Westfall Stew. Salma needs meat for her stew. Bring 3 Stringy Vulture Meat.');
  assert.equal(A.questStory(G.newStore()), '');
});
