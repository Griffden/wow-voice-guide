#!/usr/bin/env node
'use strict';
// Builds bridge/data/forever-trainer.json, the companion's offline list of
// class spells a trainer teaches on WoW: Forever, by class and level, from the
// Forever client's own spell tables on wago.tools.
//
//   node tools/build-trainer-db.js               download the tables
//   node tools/build-trainer-db.js --csv <dir>   use <Table>.csv files already downloaded
//   node tools/build-trainer-db.js --out <file>  write somewhere else
//
// Sources (https://wago.tools/db2/<Table>/csv?build=1.60.1.70009):
//   SkillLineAbility  spell -> skill line, class mask, how it is acquired
//   SkillRaceClassInfo, SkillLine, ChrClasses  which skill lines are a class's own
//   SpellLevels       the level a spell becomes trainable
//   SpellName, Spell  name and "Rank N"
//   Talent, TalentTab talent spells, which a trainer never teaches outright
//
// Training costs are not in the client tables; the add-on reads them from the
// trainer window (see bridge/trainer.js).

const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./build-quest-db');

const BUILD = '1.60.1.70009';
const TABLES = ['SkillLineAbility', 'SkillRaceClassInfo', 'SkillLine', 'ChrClasses', 'SpellLevels', 'SpellName', 'Spell', 'Talent', 'TalentTab'];
const CLASS_CATEGORY = '7'; // SkillLine.CategoryID for class skills
const ALL_CLASSES = 1535; // SkillRaceClassInfo mask for skills every class has
const TRAINER = '0'; // SkillLineAbility.AcquireMethod: learned from a trainer
// Pet abilities (a hunter's pet learns those), runes, mounts and companions.
const SKIP_LINE = /^(Pet - |Beast Training$|Engraving$|Runes$|Mounts$|Companions$)/;
// Helper spells that come with a real one: "Bear Form (Passive)", "Immolation Trap Effect".
const SKIP_NAME = /(\(Passive\d*\)| Passive| Effect)$/;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

// CSV text -> list of objects keyed by the header row.
function table(text) {
  const [header, ...rows] = parseCsv(text);
  return rows.map(r => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])));
}

async function load(dir) {
  const out = {};
  for (const name of TABLES) {
    if (dir) { out[name] = table(fs.readFileSync(path.join(dir, `${name}.csv`), 'utf8')); continue; }
    const url = `https://wago.tools/db2/${name}/csv?build=${BUILD}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'wow-voice-guide-build' } });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    out[name] = table(await response.text());
  }
  return out;
}

// The tables -> { classes, talents }.
// classes: { CLASSTOKEN: [{ l, id, n, r?, rm?, t? }, ...] } sorted by level.
//   l level, id spell id, n name, r rank, rm race mask (only when not every race),
//   t 1 = a rank of a talent: taught only to players who have the talent.
// talents: { CLASSTOKEN: { spellId: name } } for the talents behind those t ranks,
//   so a spellbook holding one of those ids shows the player has the talent.
function convert(t) {
  const lines = new Map(t.SkillLine.map(r => [r.ID, r]));
  const names = new Map(t.SpellName.map(r => [r.ID, r.Name_lang]));
  const subtext = new Map(t.Spell.map(r => [r.ID, r.NameSubtext_lang]));
  const levels = new Map();
  for (const r of t.SpellLevels) if (r.DifficultyID === '0') levels.set(r.SpellID, Number(r.SpellLevel) || Number(r.BaseLevel) || 0);
  // Talent spells, and their names per talent tab class (a warrior talent
  // called Enrage says nothing about the druid spell of that name).
  const tabClass = new Map(t.TalentTab.map(r => [r.ID, Number(r.ClassMask) || 0]));
  const talentSpells = new Set();
  const talentNames = []; // [classMask, name, spellId]
  for (const r of t.Talent) {
    for (let i = 0; i < 9; i++) {
      const id = r[`SpellRank_${i}`];
      if (!(Number(id) > 0)) continue;
      talentSpells.add(id);
      if (names.get(id)) talentNames.push([tabClass.get(r.TabID) || 0, names.get(id), Number(id)]);
    }
  }

  const out = {};
  const talents = {};
  for (const cls of t.ChrClasses) {
    const bit = 1 << (Number(cls.ID) - 1);
    const classTalents = new Set(talentNames.filter(([m]) => m & bit).map(([, n]) => n));
    const own = new Set(t.SkillRaceClassInfo
      .filter(r => { const m = Number(r.ClassMask); return m > 0 && m !== ALL_CLASSES && (m & bit); })
      .map(r => r.SkillID)
      .filter(id => lines.get(id) && lines.get(id).CategoryID === CLASS_CATEGORY && !SKIP_LINE.test(lines.get(id).DisplayName_lang)));
    const seen = new Set();
    const spells = [];
    for (const r of t.SkillLineAbility) {
      if (!own.has(r.SkillLine) || r.AcquireMethod !== TRAINER || talentSpells.has(r.Spell)) continue;
      const mask = Number(r.ClassMask);
      if (!mask || !(mask & bit)) continue; // 0 = talents and effects, not trainer spells
      const n = names.get(r.Spell);
      const l = levels.get(r.Spell) || 0;
      const sub = String(subtext.get(r.Spell) || '');
      if (!n || l < 2 || SKIP_NAME.test(n) || sub === 'Passive') continue;
      const rank = Number((sub.match(/^Rank (\d+)$/) || [])[1]) || 0;
      if (classTalents.has(n) && !rank) continue; // a talent's effect, not a rank of it
      const rm = Number(r.RaceMasks_0) || 0;
      const key = `${n}|${rank}|${rm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = { l, id: Number(r.Spell), n };
      if (rank) s.r = rank;
      if (rm && rm !== -1) s.rm = rm;
      if (classTalents.has(n)) s.t = 1;
      spells.push(s);
    }
    spells.sort((a, b) => a.l - b.l || a.n.localeCompare(b.n) || (a.r || 0) - (b.r || 0));
    if (!spells.length) continue;
    out[cls.Filename] = spells;
    const gated = new Set(spells.filter(s => s.t).map(s => s.n));
    const ids = talentNames.filter(([m, n]) => (m & bit) && gated.has(n)).sort((a, b) => a[2] - b[2]);
    if (ids.length) talents[cls.Filename] = Object.fromEntries(ids.map(([, n, id]) => [id, n]));
  }
  return { classes: out, talents };
}

async function build() {
  const out = arg('--out') || path.join(__dirname, '..', 'bridge', 'data', 'forever-trainer.json');
  const { classes, talents } = convert(await load(arg('--csv')));
  const meta = {
    source: `WoW: Forever client tables (build ${BUILD}) from https://wago.tools/db2, converted by tools/build-trainer-db.js`,
    clientBuild: BUILD,
    generated: new Date().toISOString().slice(0, 10),
    counts: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, v.length])),
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // One spell per line: readable diffs when the data is rebuilt.
  const body = [
    '{',
    `"meta":${JSON.stringify(meta)},`,
    '"classes":{',
    Object.entries(classes).map(([cls, list]) => `"${cls}":[\n${list.map(s => JSON.stringify(s)).join(',\n')}\n]`).join(',\n'),
    '},',
    `"talents":${JSON.stringify(talents)}`,
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(out, body);
  console.log(`wrote ${out}: ${Object.entries(meta.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

if (require.main === module) build().catch(e => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { convert, table };
