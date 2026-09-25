'use strict';
// The offline WoW: Forever quest database (bridge/data/forever-quests.json,
// converted from AllTheThings by tools/build-quest-db.js): which quests the
// player can pick up near them, and where a quest's giver stands.
//
//   questsNear(opts)    eligible quests whose giver is on the player's map,
//                       nearest first (level, faction/race/class, completed and
//                       active quests, prerequisites)
//   questInfo(query)    one quest by id or name: givers with coordinates
//   zoneSummary(opts)   a short spoken line about a zone's available quests
//
// Quest records (compact keys): n name, l minimum level, f faction A/H,
// r races, c classes, pre prerequisite quest ids (pn = how many are needed),
// alt mutually exclusive quests, b breadcrumb, rep repeatable, sk required
// skill, g givers [npcId, x, y, uiMapId, faction?], m maps, ev holiday,
// old = from ATT's older, not yet Forever-reviewed files.

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'forever-quests.json');
const RACE_TOKENS = Object.freeze({
  'night elf': 'NIGHTELF', 'blood elf': 'BLOODELF', human: 'HUMAN', dwarf: 'DWARF', gnome: 'GNOME', draenei: 'DRAENEI',
  worgen: 'WORGEN', orc: 'ORC', undead: 'UNDEAD', scourge: 'UNDEAD', tauren: 'TAUREN', troll: 'TROLL', goblin: 'GOBLIN',
});
const SOURCE = 'AllTheThings WoW: Forever quest database (offline copy)';

let loaded = null;

function load(file) {
  if (loaded && (!file || loaded.file === file)) return loaded.db;
  file = file || DB_FILE;
  let db;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { db = { meta: {}, maps: {}, npcs: {}, quests: {} }; }
  loaded = { file, db };
  return db;
}

// Tests hand in a fixture instead of the shipped file.
function use(db) { loaded = { file: '(fixture)', db }; }

function available() {
  return Object.keys(load().quests || {}).length > 0;
}

function words(text) {
  return String(text || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function mapName(id) {
  return (load().maps || {})[id] || `map ${id}`;
}

function mapIdByName(name) {
  const wanted = words(name);
  if (!wanted) return null;
  for (const [id, n] of Object.entries(load().maps || {})) if (words(n) === wanted) return Number(id);
  return null;
}

function npcName(id) {
  return (load().npcs || {})[id] || (id ? `NPC ${id}` : 'unknown');
}

function direction(dx, dy) {
  // Map y grows southward.
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  const names = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  return names[(Math.round(angle / 45) + 8) % 8];
}

function givers(q, faction) {
  return (q.g || []).filter(g => !g[4] || !faction || g[4] === faction[0]).map(g => ({
    npcId: g[0] || null,
    npc: g[0] ? npcName(g[0]) : null,
    ...(g.length >= 4 ? { x: g[1], y: g[2], mapId: g[3], zone: mapName(g[3]) } : {}),
  }));
}

function wowheadUrl(id) {
  return `https://www.wowhead.com/forever/quest=${id}`;
}

// Why the player can't take this quest now, or '' when they can.
function blocker(id, q, { player = {}, completed = new Set(), active = new Set(), knowsCompleted = false } = {}) {
  if (active.has(id)) return 'already in your quest log';
  if (completed.has(id) && !q.rep) return 'already completed';
  const faction = player.faction ? player.faction[0] : '';
  if (q.f && faction && q.f !== faction) return `${q.f === 'A' ? 'Alliance' : 'Horde'} only`;
  const race = RACE_TOKENS[String(player.race || '').toLowerCase()];
  if (q.r && race && !q.r.includes(race)) return 'for other races';
  const cls = String(player.class || '').toUpperCase().replace(/\s+/g, '');
  if (q.c && cls && !q.c.includes(cls)) return `${q.c.map(c => c[0] + c.slice(1).toLowerCase()).join('/')} only`;
  if (q.l && player.level && q.l > player.level) return `requires level ${q.l}`;
  if (knowsCompleted) {
    if (q.alt && q.alt.some(a => completed.has(a))) return 'replaced by a quest you already did';
    if (q.pre && q.pre.length) {
      const done = q.pre.filter(p => completed.has(p)).length;
      if (done < (q.pn || q.pre.length)) return 'needs an earlier quest first';
    }
  }
  return '';
}

// Eligible quests with a giver on the map, nearest first.
//   player: { level, race, class, faction, mapId, x, y } (x, y 0-100)
//   mapId:  another map than the player's (optional)
function questsNear({ player = {}, completed = new Set(), active = new Set(), mapId, limit = 8, includeEvents = false } = {}) {
  const db = load();
  const map = Number(mapId || player.mapId) || null;
  if (!map) return { mapId: null, zone: '', quests: [], note: 'Your map position is unknown.' };
  const here = !mapId || Number(mapId) === Number(player.mapId);
  const knowsCompleted = completed.size > 0;
  const found = [];
  for (const [key, q] of Object.entries(db.quests || {})) {
    const id = Number(key);
    if (q.ev && !includeEvents) continue;
    const onMap = givers(q, player.faction).filter(g => g.mapId === map);
    if (!onMap.length && !(q.m || []).includes(map)) continue;
    if (blocker(id, q, { player, completed, active, knowsCompleted })) continue;
    let best = onMap[0] || null, distance = null;
    if (here && typeof player.x === 'number') {
      for (const g of onMap) {
        const d = Math.hypot(g.x - player.x, g.y - player.y);
        if (distance === null || d < distance) { distance = d; best = g; }
      }
    }
    found.push({ id, q, giver: best, distance });
  }
  const level = player.level || 0;
  found.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9) ||
    Math.abs((a.q.l || level) - level) - Math.abs((b.q.l || level) - level) || a.id - b.id);
  const quests = found.slice(0, Math.max(1, Math.min(limit, 25))).map(({ id, q, giver, distance }) => ({
    id,
    name: q.n,
    ...(q.l ? { minLevel: q.l } : {}),
    ...(giver ? { giver: giver.npc, x: giver.x, y: giver.y, zone: giver.zone } : { zone: mapName(map) }),
    ...(distance !== null ? { distance: Math.round(distance * 10) / 10, direction: direction(giver.x - player.x, giver.y - player.y) } : {}),
    ...(q.b ? { breadcrumb: true } : {}),
    ...(q.pre && !knowsCompleted ? { mayNeed: q.pre.map(p => `${questName(p)} (#${p})`) } : {}),
    ...(q.old ? { unverified: true } : {}),
    url: wowheadUrl(id),
  }));
  return {
    mapId: map,
    zone: mapName(map),
    total: found.length,
    quests,
    source: SOURCE,
    ...(knowsCompleted ? {} : { note: 'Completed quests are unknown, so some of these may be done or need an earlier quest.' }),
    ...(quests.some(q => q.unverified) ? { unverifiedNote: 'unverified: from older ATT data not yet reviewed for Forever' } : {}),
  };
}

function questName(id) {
  const q = (load().quests || {})[id];
  return q ? q.n : `quest ${id}`;
}

// One quest by id ("3519", "#3519") or by name (best match).
function questInfo(query, { player = {}, completed = new Set(), active = new Set() } = {}) {
  const db = load();
  const text = String(query ?? '').trim();
  const idMatch = text.match(/^#?(\d{1,6})$/);
  let ids = [];
  if (idMatch && db.quests[idMatch[1]]) ids = [Number(idMatch[1])];
  else {
    const wanted = words(text);
    if (!wanted) return { error: 'Give a quest id or name.' };
    const scored = [];
    for (const [key, q] of Object.entries(db.quests || {})) {
      const name = words(q.n.replace(/\s*[[(][^\])]*[\])]\s*$/g, ''));
      const full = words(q.n);
      let score = 0;
      if (full === wanted || name === wanted) score = 3;
      else if (full.startsWith(wanted) || name.includes(wanted)) score = 2;
      else if (wanted.split(' ').filter(w => w.length > 2).every(w => full.includes(w))) score = 1;
      if (score) scored.push({ id: Number(key), score, q });
    }
    const faction = player.faction ? player.faction[0] : '';
    scored.sort((a, b) => b.score - a.score || Number(!!a.q.old) - Number(!!b.q.old) ||
      Number(!!(a.q.f && faction && a.q.f !== faction)) - Number(!!(b.q.f && faction && b.q.f !== faction)) || a.id - b.id);
    ids = scored.slice(0, 3).map(s => s.id);
  }
  if (!ids.length) return { results: [], note: 'No quest by that id or name in the offline Forever database. Try wowhead_search.' };
  const knowsCompleted = completed.size > 0;
  return {
    source: SOURCE,
    results: ids.map(id => {
      const q = db.quests[id];
      const why = blocker(id, q, { player, completed, active, knowsCompleted });
      return {
        id,
        name: q.n,
        ...(q.l ? { minLevel: q.l } : {}),
        ...(q.f ? { faction: q.f === 'A' ? 'Alliance' : 'Horde' } : {}),
        ...(q.r ? { races: q.r } : {}),
        ...(q.c ? { classes: q.c } : {}),
        givers: givers(q, player.faction),
        ...(q.m ? { zones: q.m.map(mapName) } : {}),
        ...(q.pre ? { prerequisites: q.pre.map(p => ({ id: p, name: questName(p), done: completed.has(p) })) } : {}),
        ...(q.b ? { breadcrumb: true } : {}),
        ...(q.rep ? { repeatable: true } : {}),
        ...(q.ev ? { event: q.ev } : {}),
        ...(q.old ? { unverified: 'from older ATT data not yet reviewed for Forever' } : {}),
        status: active.has(id) ? 'in your quest log' : completed.has(id) ? 'completed' : why || 'available',
        url: wowheadUrl(id),
      };
    }),
  };
}

// Givers with coordinates as lookup results, for waypoints (providers.js).
function locatedGivers(results) {
  const out = [];
  for (const r of results || []) {
    for (const g of r.givers || (r.giver ? [{ npc: r.giver, x: r.x, y: r.y, mapId: (r.mapId || mapIdByName(r.zone)) }] : [])) {
      if (g.npc && typeof g.x === 'number' && g.mapId) out.push({ name: g.npc, location: { uiMapId: g.mapId, coords: [[g.x, g.y]] }, url: r.url });
    }
  }
  return out;
}

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// One spoken sentence or two: how many quests are available here and the nearest.
function zoneSummary(opts = {}) {
  const near = questsNear({ ...opts, limit: 3 });
  if (!near.mapId) return '';
  if (!near.total) return `I don't know of any quests you can pick up in ${near.zone} right now.`;
  const nearest = near.quests.filter(q => q.giver).map(q => `${q.name} from ${q.giver}${q.direction ? ` to the ${q.direction}` : ''}`);
  return `There ${near.total === 1 ? 'is 1 quest' : `are ${near.total} quests`} you can pick up in ${near.zone}${nearest.length ? `. Nearest: ${listNames(nearest)}` : ''}.`;
}

// A compact block for model prompts (Gemini/local presets have no tools).
function nearbyNotes(opts = {}) {
  const near = questsNear({ ...opts, limit: 6 });
  if (!near.mapId || !near.quests.length) return '';
  const lines = near.quests.map(q => `- ${q.name} (#${q.id})${q.minLevel ? `, level ${q.minLevel}+` : ''}${q.giver ? `: ${q.giver} at ${q.x}, ${q.y}` : ''}${q.direction ? `, ${q.distance} map units ${q.direction}` : ''}${q.breadcrumb ? ', breadcrumb' : ''}${q.unverified ? ', unverified for Forever' : ''}`);
  return `Quests the player can pick up in ${near.zone} (${near.total} in total, nearest first; ${SOURCE}${near.note ? `; ${near.note}` : ''}):\n${lines.join('\n')}`;
}

// Questions that ask what to do or pick up.
function asksForQuests(question) {
  return /\b(what (?:should|can|could|do) i do|anything to do|quests? (?:near|nearby|around|here|to (?:do|pick up|get))|pick up|any (?:more )?quests|where (?:can|do|should) i (?:find|get) (?:more )?quests|new quests|what next|what now|bored)\b/i.test(String(question || ''));
}

module.exports = {
  DB_FILE, load, use, available, questsNear, questInfo, zoneSummary, nearbyNotes, asksForQuests,
  locatedGivers, mapName, mapIdByName, npcName, direction, wowheadUrl,
};
