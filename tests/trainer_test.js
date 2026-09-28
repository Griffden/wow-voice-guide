'use strict';
// Class trainer spells: the build from the Forever client tables, what a
// level-up announces, the prices from trainer visits, and the guide's line.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../bridge/trainer');
const G = require('../bridge/gamestate');
const A = require('../bridge/announce');
const { convert, table } = require('../tools/build-trainer-db');

const csv = rows => table(rows.map(r => r.join(',')).join('\n'));

test('the build keeps a class\'s trainer spells and drops talents, pet abilities, helpers and passives', () => {
  const out = convert({
    ChrClasses: csv([['ID', 'Filename'], ['1', 'WARRIOR'], ['3', 'HUNTER']]),
    SkillLine: csv([['ID', 'DisplayName_lang', 'CategoryID'], ['26', 'Arms', '7'], ['261', 'Beast Training', '7'], ['51', 'Survival', '7'], ['95', 'Defense', '6']]),
    SkillRaceClassInfo: csv([['SkillID', 'ClassMask'], ['26', '1'], ['261', '4'], ['51', '4'], ['95', '1535']]),
    SkillLineAbility: csv([['SkillLine', 'Spell', 'ClassMask', 'AcquireMethod', 'RaceMasks_0'],
      ['26', '78', '1', '2', '0'], // Heroic Strike 1: learned automatically
      ['26', '284', '1', '0', '0'], // Heroic Strike 2
      ['26', '12294', '1', '0', '0'], // Mortal Strike 1: a talent
      ['26', '21551', '1', '0', '0'], // Mortal Strike 2: a rank of that talent
      ['26', '12282', '0', '0', '0'], // a talent rank row with no class mask
      ['26', '7376', '1', '0', '0'], // Defensive Stance Passive
      ['261', '4195', '4', '0', '0'], // Great Stamina: the pet learns it
      ['51', '13795', '4', '0', '0'], // Immolation Trap
      ['51', '13797', '4', '0', '0'], // Immolation Trap Effect
      ['51', '5502', '4', '0', '-1'], // every race
      ['51', '9035', '4', '0', '128'], // one race
    ]),
    SpellLevels: csv([['DifficultyID', 'BaseLevel', 'SpellLevel', 'SpellID'],
      ['0', '1', '1', '78'], ['0', '8', '8', '284'], ['0', '40', '40', '12294'], ['0', '48', '48', '21551'], ['0', '1', '1', '12282'],
      ['0', '10', '10', '7376'], ['0', '10', '10', '4195'], ['0', '16', '16', '13795'], ['0', '16', '16', '13797'], ['0', '20', '20', '5502'], ['0', '10', '10', '9035']]),
    SpellName: csv([['ID', 'Name_lang'], ['78', 'Heroic Strike'], ['284', 'Heroic Strike'], ['12294', 'Mortal Strike'], ['21551', 'Mortal Strike'],
      ['12282', 'Improved Heroic Strike'], ['7376', 'Defensive Stance Passive'], ['4195', 'Great Stamina'], ['13795', 'Immolation Trap'],
      ['13797', 'Immolation Trap Effect'], ['5502', 'Sense Undead'], ['9035', 'Hex of Weakness']]),
    Spell: csv([['ID', 'NameSubtext_lang'], ['78', 'Rank 1'], ['284', 'Rank 2'], ['12294', 'Rank 1'], ['21551', 'Rank 2'], ['13795', 'Rank 1'], ['9035', 'Rank 1']]),
    Talent: csv([['TabID', 'SpellRank_0', 'SpellRank_1'], ['161', '12294', '0'], ['161', '12282', '0']]),
    TalentTab: csv([['ID', 'ClassMask'], ['161', '1']]),
  });
  assert.deepEqual(out.classes.WARRIOR, [
    { l: 8, id: 284, n: 'Heroic Strike', r: 2 },
    { l: 48, id: 21551, n: 'Mortal Strike', r: 2, t: 1 },
  ]);
  assert.deepEqual(out.classes.HUNTER, [
    { l: 10, id: 9035, n: 'Hex of Weakness', r: 1, rm: 128 },
    { l: 16, id: 13795, n: 'Immolation Trap', r: 1 },
    { l: 20, id: 5502, n: 'Sense Undead' },
  ]);
  assert.deepEqual(out.talents, { WARRIOR: { 12294: 'Mortal Strike' } });
});

const DB = {
  classes: {
    WARRIOR: [
      { l: 10, id: 355, n: 'Taunt' },
      { l: 12, id: 7384, n: 'Overpower', r: 1 },
      { l: 12, id: 72, n: 'Shield Bash', r: 1 },
      { l: 14, id: 6572, n: 'Revenge', r: 1 },
      { l: 14, id: 1160, n: 'Demoralizing Shout', r: 1 },
      { l: 14, id: 9999, n: 'Night Elf Thing', rm: 8 },
      { l: 16, id: 285, n: 'Heroic Strike', r: 3 },
      { l: 16, id: 2565, n: 'Shield Block' },
      { l: 48, id: 21551, n: 'Mortal Strike', r: 2, t: 1 },
    ],
  },
  talents: { WARRIOR: { 12294: 'Mortal Strike' } },
};
const warrior = level => ({ class: 'Warrior', race: 'Human', level });

test('a level-up names the new spells, what they cost, and what was skipped', () => {
  const known = new Set([355, 72]);
  const info = T.lookup(warrior(14), known, { db: DB });
  assert.deepEqual(info.due.map(s => s.n), ['Revenge', 'Demoralizing Shout'], 'another race\'s spell is left out');
  assert.deepEqual(info.missed.map(s => s.n), ['Overpower']);
  assert.deepEqual(info.next.map(T.spellLabel), ['Heroic Strike rank 3', 'Shield Block']);
  assert.equal(T.levelUpText(warrior(14), known, { 'Revenge|1': 600, 'Demoralizing Shout|1': 10500 }, { db: DB }),
    'New at your warrior trainer: Revenge and Demoralizing Shout, 1 gold 11 silver in all. You also haven\'t trained Overpower.');
  assert.equal(T.levelUpText(warrior(14), known, { 'Revenge|1': 600 }, { db: DB }),
    'New at your warrior trainer: Revenge and Demoralizing Shout. You also haven\'t trained Overpower.', 'no total unless every price is known');
  assert.equal(T.levelUpText(warrior(15), new Set([355, 72, 7384, 6572, 1160]), null, { db: DB }), 'Nothing new at your warrior trainer this level.');
  // Without the spellbook nothing counts as skipped.
  assert.equal(T.levelUpText(warrior(14), null, null, { db: DB }), 'New at your warrior trainer: Revenge and Demoralizing Shout.');
  assert.equal(T.levelUpText({ class: 'Monk', level: 14 }, null, null, { db: DB }), '', 'no data for the class');
});

test('a talent\'s higher ranks are only for players who have the talent; a higher rank known covers the lower', () => {
  assert.deepEqual(T.lookup(warrior(48), new Set(), { db: DB }).due, []);
  assert.deepEqual(T.lookup(warrior(48), new Set([12294]), { db: DB }).due.map(T.spellLabel), ['Mortal Strike rank 2']);
  const db = { classes: { WARRIOR: [{ l: 8, id: 284, n: 'Heroic Strike', r: 2 }, { l: 16, id: 285, n: 'Heroic Strike', r: 3 }] } };
  assert.deepEqual(T.lookup(warrior(20), new Set([285]), { db }).missed, [], 'rank 2 is not missed when rank 3 is known');
});

test('trainer prices merge per class, and money is spoken plainly', () => {
  const prices = {};
  assert.equal(T.mergeCosts(prices, 'Revenge|1|600;Shield Block|0|1200;bad;Taunt|x|y'), 2);
  assert.deepEqual(prices, { 'Revenge|1': 600, 'Shield Block|0': 1200 });
  assert.equal(T.mergeCosts(prices, 'Revenge|1|600'), 0, 'unchanged');
  assert.equal(T.spokenMoney(10500), '1 gold 5 silver');
  assert.equal(T.spokenMoney(600), '6 silver');
  assert.equal(T.spokenMoney(85), '85 copper');
});

test('the guide gets one line about training', () => {
  const line = T.contextLine(warrior(14), new Set([355, 72]), { 'Revenge|1': 600 }, { db: DB });
  assert.equal(line, 'Class trainer (Forever client data): trainable now and not known: Overpower (level 12); Revenge (level 14, 6 silver); Demoralizing Shout (level 14). Next at level 16: Heroic Strike rank 3, Shield Block.');
});

test('the shipped data covers every Forever class and knows a warrior\'s level 14', () => {
  assert.ok(T.available());
  const db = T.load();
  assert.deepEqual(Object.keys(db.classes).sort(), ['DRUID', 'HUNTER', 'MAGE', 'PALADIN', 'PRIEST', 'ROGUE', 'SHAMAN', 'WARLOCK', 'WARRIOR']);
  const due = T.lookup(warrior(14), new Set()).due.map(s => s.n);
  assert.ok(due.includes('Revenge') && due.includes('Demoralizing Shout'), due.join(', '));
});

test('the level announcement uses the spellbook and prices from the game state', () => {
  // Taunt and Overpower known, as the add-on encodes them: sorted, base-36 deltas.
  const ids = [355, 7384];
  const game = G.newStore();
  G.applySections(game, G.encodeSections([
    ['char', 'Character: Testchar on Realm, level 13 Human Warrior (Alliance)'],
    ['spells', '2 known in 1 chunks'],
    ['spells.1', `${ids[0].toString(36)},${(ids[1] - ids[0]).toString(36)}`],
  ]));
  assert.deepEqual([...G.knownSpellIds(game)], ids);
  const moment = G.encodeSections([['kind', 'level'], ['level', '14'], ['spells', '']]);
  const say = A.compose(A.fieldsOf(moment), { game, trainerCosts: { WARRIOR: { 'Revenge|1': 600 } } });
  assert.match(say, /^Level 14! New at your warrior trainer: .*Revenge/);
  assert.doesNotMatch(say, /Overpower/, 'known spells are not announced');
  assert.equal(G.knownSpellIds(G.newStore()), null, 'not reported yet');
});
