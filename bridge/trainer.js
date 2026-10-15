'use strict';
// Class trainer spells on WoW: Forever: which ones the player can train now,
// which they skipped, and what the trainer charged. Pure apart from reading
// bridge/data/forever-trainer.json (built by tools/build-trainer-db.js from
// the Forever client's own spell tables).
//
// The add-on reports the spells the player knows (the "spells" state section)
// and, whenever a class trainer window is open, what that trainer offers with
// its prices (the "train" section). The client tables have no prices, so costs
// come only from trainer visits and are kept per class in state.json.

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'forever-trainer.json');
const RACE_IDS = Object.freeze({
  Human: 1, Orc: 2, Dwarf: 3, 'Night Elf': 4, Undead: 5, Tauren: 6, Gnome: 7, Troll: 8, Goblin: 9, 'Blood Elf': 10, Draenei: 11,
});
const MISSED_MAX = 3;
const NEW_MAX = 6;

let loaded = null;

function load(file = DB_FILE) {
  if (loaded && loaded.file === file) return loaded.db;
  let db = null;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = null; }
  loaded = { file, db };
  return db;
}

function available() {
  const db = load();
  return !!(db && db.classes);
}

// "Night Elf" -> 4; "Warrior" -> "WARRIOR".
function raceId(name) { return RACE_IDS[name] || 0; }
function classToken(name) { return String(name || '').toUpperCase().replace(/[^A-Z]/g, ''); }

function costKey(name, rank) { return `${name}|${rank || 0}`; }

// "Heroic Strike rank 3", or just the name for a first rank.
function spellLabel(s) { return s.r > 1 ? `${s.n} rank ${s.r}` : s.n; }

// What the player can and did train.
//   player: { class, race, level } (GameState.playerInfo)
//   known:  Set of spell ids from the spellbook, or null when the add-on has not said
// Returns null without data for the class, else
//   { token, level, due: spells of this level not known,
//     missed: earlier spells not known (only when `known` is given), next: the next level's spells }
function lookup(player, known, { db = load() } = {}) {
  const token = classToken(player && player.class);
  const list = db && db.classes && db.classes[token];
  const level = Number(player && player.level) || 0;
  if (!list || !level) return null;
  const race = raceId(player.race);
  const ranks = new Map(); // name -> highest rank known
  const talents = new Set();
  if (known) {
    for (const s of list) if (known.has(s.id)) ranks.set(s.n, Math.max(ranks.get(s.n) ?? 0, s.r || 0));
    for (const [id, name] of Object.entries((db.talents && db.talents[token]) || {})) if (known.has(Number(id))) talents.add(name);
  }
  const fits = s => {
    if (s.rm && !(race && (s.rm & (1 << (race - 1))))) return false;
    if (s.t) return !!known && (talents.has(s.n) || ranks.has(s.n));
    return true;
  };
  const isKnown = s => ranks.has(s.n) && ranks.get(s.n) >= (s.r || 0);
  const due = [], missed = [], next = [];
  let nextLevel = 0;
  for (const s of list) {
    if (!fits(s) || isKnown(s)) continue;
    if (s.l === level) due.push(s);
    else if (s.l < level) { if (known) missed.push(s); }
    else if (!nextLevel || s.l === nextLevel) { nextLevel = s.l; next.push(s); }
  }
  // The most recent skipped spells first: they are the likeliest still wanted.
  missed.sort((a, b) => b.l - a.l);
  return { token, level, due, missed, next, nextLevel };
}

// Total copper for the spells when every price is known, else null.
function totalCost(spells, costs) {
  if (!costs || !spells.length) return null;
  let total = 0;
  for (const s of spells) {
    const c = costs[costKey(s.n, s.r)];
    if (typeof c !== 'number') return null;
    total += c;
  }
  return total;
}

// Copper -> words for the voice: "1 gold 20 silver", "35 silver", "80 copper".
function spokenMoney(copper) {
  const g = Math.floor(copper / 10000), s = Math.floor(copper / 100) % 100, c = copper % 100;
  const parts = [];
  if (g) parts.push(`${g} gold`);
  if (s) parts.push(`${s} silver`);
  if (c && !g) parts.push(`${c} copper`);
  return parts.join(' ') || '0 copper';
}

function joinNames(names, max) {
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

// The sentences after "Level N!", or '' when the class is unknown.
function levelUpText(player, known, costs, opts = {}) {
  const info = lookup(player, known, opts);
  if (!info) return '';
  const cls = String(player.class).toLowerCase();
  const parts = [];
  if (info.due.length) {
    const total = totalCost(info.due, costs);
    parts.push(`New at your ${cls} trainer: ${joinNames(info.due.map(spellLabel), NEW_MAX)}${total !== null ? `, ${spokenMoney(total)} in all` : ''}.`);
  } else {
    parts.push(`Nothing new at your ${cls} trainer this level.`);
  }
  if (info.missed.length) parts.push(`You also haven't trained ${joinNames(info.missed.map(spellLabel), MISSED_MAX)}.`);
  return parts.join(' ');
}

// One line for the guide's context when a question is about training.
function contextLine(player, known, costs, opts = {}) {
  const info = lookup(player, known, opts);
  if (!info) return '';
  const cost = s => { const c = costs && costs[costKey(s.n, s.r)]; return typeof c === 'number' ? `, ${spokenMoney(c)}` : ''; };
  const now = [...info.due, ...info.missed].sort((a, b) => a.l - b.l).map(s => `${spellLabel(s)} (level ${s.l}${cost(s)})`);
  const parts = [`Class trainer (Forever client data${known ? '' : ', spellbook not reported yet'}): `];
  parts.push(now.length ? `trainable now and not known: ${now.slice(0, 12).join('; ')}${now.length > 12 ? `; +${now.length - 12} more` : ''}.` : 'nothing left to train at this level.');
  if (info.next.length) parts.push(` Next at level ${info.nextLevel}: ${info.next.map(spellLabel).join(', ')}.`);
  return parts.join('');
}

// The add-on's "train" section ("Name|rank|copper" joined by ";") merged into
// a class's price list. Returns how many prices were new or changed.
function mergeCosts(prices, text) {
  let changed = 0;
  for (const item of String(text || '').split(';')) {
    const [name, rank, copper] = item.split('|');
    const c = Number(copper);
    if (!name || !Number.isFinite(c) || c < 0) continue;
    const key = costKey(name.trim(), Number(rank) || 0);
    if (prices[key] !== c) { prices[key] = c; changed++; }
  }
  return changed;
}

module.exports = {
  available, load, raceId, classToken, costKey, spellLabel,
  lookup, totalCost, spokenMoney, levelUpText, contextLine, mergeCosts,
};
