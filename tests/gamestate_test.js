'use strict';
// The bridge's merged game state (bridge/gamestate.js): section records in,
// a budgeted, question-aware model context out.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../bridge/gamestate');
const P = require('../bridge/protocol');

const CHAR = 'Game: World of Warcraft: Forever (client 1.60.1.69913, interface 16001)\nCharacter: Testchar on Test Realm, level 23 Night Elf Hunter (Alliance), guild <Test Guild>\nHearthstone: Darkshire';
const LOC = 'Location: Duskwood - Darkshire\nPosition: 45.2, 67.8 (map 1431)';

function store(pairs, now = 1000) {
  const s = G.newStore();
  G.applySections(s, G.encodeSections(pairs), { now, session: 'abc' });
  return s;
}

test('a section record from the strip applies, updates, deletes and clears sections', () => {
  const record = ['abc', 'chat1', '41', '', 's', 'Chat 1', G.encodeSections([['*', ''], ['char', CHAR], ['loc', LOC], ['target', '']]), ''].join('\x1F');
  const job = P.jobsFromStrip(41, record)[0];
  assert.equal(job.state, G.encodeSections([['*', ''], ['char', CHAR], ['loc', LOC], ['target', '']]));
  assert.equal(job.ctx, undefined);
  assert.equal(job.text, '');
  const s = G.newStore();
  assert.deepEqual(G.applySections(s, job.state, { now: 5, session: 'abc' }).sort(), ['char', 'loc']);
  assert.deepEqual(Object.keys(s.sections), ['char', 'loc']);
  assert.equal(s.session, 'abc');
  // Unchanged text is not a change; an empty value deletes; "*" clears everything.
  assert.deepEqual(G.applySections(s, G.encodeSections([['char', CHAR]])), []);
  assert.deepEqual(G.applySections(s, G.encodeSections([['loc', '']])), ['loc']);
  assert.deepEqual(Object.keys(s.sections), ['char']);
  G.applySections(s, G.encodeSections([['*', '']]));
  assert.deepEqual(s.sections, {});
  // Junk keys are ignored.
  G.applySections(s, 'bad key\x1Dx\x1C\x1Dy');
  assert.deepEqual(s.sections, {});
});

test('an older add-on context string becomes the one legacy section', () => {
  const s = store([['char', CHAR]]);
  G.setLegacyContext(s, 'Character: Old, level 5 Orc Warrior (Horde)');
  assert.deepEqual(Object.keys(s.sections), ['legacy']);
  assert.match(G.assembleContext(s, 'hi', { now: 1000 }), /Character: Old/);
  G.setLegacyContext(s, '');
  assert.deepEqual(s.sections, {});
});

test('completed quest ids decode from chunks plus the turn-in delta, ignoring stale chunks', () => {
  assert.deepEqual([...G.decodeIds('1~2,2,2~1,lj')], [1, 2, 3, 5, 7, 8, 783]);
  assert.deepEqual([...G.decodeIds('a~3,11,6wm~1')], [10, 11, 12, 13, 50, 9000, 9001]);
  const s = store([['done', '8 completed in 2 chunks'], ['done.1', '1~2'], ['done.2', '2s,1'], ['done.3', 'zz'], ['done.new', '1q']]);
  assert.deepEqual([...G.completedQuestIds(s)].sort((a, b) => a - b), [1, 2, 3, 62, 100, 101]);
});

test('playerInfo and questLogIds read the sections the add-on sends', () => {
  const s = store([['char', CHAR], ['loc', 'Location: Elwynn Forest\nPosition: 10.0, 67.8 on Duskwood (map 1431)'],
    ['quests', 'Quest log (2): Wolves Across the Border (#33) [0/8 Tough Wolf Meat]; The Fargodeep Mine (#62) [ready to turn in]'],
    ['quest', 'Tracked quest: Wolves Across the Border (id 33)']]);
  assert.deepEqual(G.playerInfo(s), { name: 'Testchar', level: 23, race: 'Night Elf', class: 'Hunter', faction: 'Alliance', zone: 'Elwynn Forest', x: 10, y: 67.8, mapId: 1431, mapName: 'Duskwood' });
  assert.deepEqual([...G.questLogIds(s)], [33, 62]);
});

test('the model context keeps a fixed order, puts what the question needs first, and fits the budget', () => {
  const now = 100000;
  const s = G.newStore();
  G.applySections(s, G.encodeSections([
    ['char', CHAR], ['loc', LOC], ['prog', 'Money: 1g; XP: 1/2'],
    ['quest', 'Tracked quest: Wolves Across the Border (id 33)\nObjective: 0/8 Tough Wolf Meat'],
    ['quests', 'Quest log (1): Wolves Across the Border (#33) [0/8 Tough Wolf Meat]'],
    ['talents', 'Specialization: Beast Mastery\nTalents (4 points): ' + 'Improved Aspect of the Hawk 3, '.repeat(30)],
    ['gear', 'Bags: 2 of 16 slots free\nEquipped: ' + 'Chest Fine Chestpiece (19); '.repeat(20)],
    ['taxi', 'Known flight paths (2): Auberdine, Darkshore; Rut\'theran Village, Teldrassil'],
    ['done', '3 completed in 1 chunks'], ['done.1', '1~2'],
  ]), { now: now - 60000 });
  G.applySections(s, G.encodeSections([['npc', 'Talking to: Marshal Dughan\nSays: Ach.']]), { now: now - 30000 });
  const full = G.assembleContext(s, 'where do I go', { now, maxChars: 10000 });
  const order = ['Character:', 'Location:', 'Money:', 'Last NPC dialog', 'Tracked quest:', 'Quest log', 'Specialization:', 'Bags:', 'Known flight paths', 'Completed quests: 3'];
  const at = order.map(p => full.indexOf(p));
  assert.ok(at.every(i => i >= 0), full);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'sections render in a fixed order');
  assert.match(full, /Last NPC dialog \(opened 30 s ago\):\nTalking to: Marshal Dughan/);
  // A tight budget keeps the essentials and what the question is about.
  const talents = G.assembleContext(s, 'what talents should I take next', { now, maxChars: 1500 });
  assert.match(talents, /Specialization: Beast Mastery/);
  assert.match(talents, /Character: Testchar/);
  assert.doesNotMatch(talents, /Equipped:/);
  assert.ok(talents.length <= 1500);
  const gear = G.assembleContext(s, 'is my gear ok, do I need to repair?', { now, maxChars: 1500 });
  assert.match(gear, /Bags: 2 of 16/);
  assert.doesNotMatch(gear, /Specialization/);
  // An old dialog drops out.
  assert.doesNotMatch(G.assembleContext(s, 'hi', { now: now + 3600 * 1000 }), /NPC dialog/);
});
