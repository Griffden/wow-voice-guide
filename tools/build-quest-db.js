#!/usr/bin/env node
'use strict';
// Builds bridge/data/forever-quests.json, the companion's offline WoW: Forever
// quest database, from the AllTheThings (ATT) Forever data (MIT licensed) and
// the Forever client's UiMap table on wago.tools.
//
//   node tools/build-quest-db.js                 download ATT at its latest commit
//   node tools/build-quest-db.js --att <dir>     use a local AllTheThings checkout
//   node tools/build-quest-db.js --out <file>    write somewhere else
//
// Sources:
//   https://github.com/ATTWoWAddon/AllTheThings  .contrib/.db/forever/**.lua
//     (zzOLD/ = ATT's older Classic-era files not yet reviewed for Forever;
//      their quests are kept only where the reviewed files lack them, marked old)
//   .contrib/Parser/lib/Constants/Maps.lua and the forever .config constants
//   https://wago.tools/db2/UiMap/csv?build=1.60.1.70009  (valid Forever map ids)
//
// The output keeps ATT's MIT copyright notice; see bridge/data/README.md.

const fs = require('fs');
const path = require('path');
const ATT = require('./att-parser');

const REPO = 'ATTWoWAddon/AllTheThings';
const BRANCH = 'master';
const BUILD = '1.60.1.70009';
const FOREVER_DIR = '.contrib/.db/forever/';
const CONSTANT_FILES = [
  '.contrib/Parser/lib/Constants/Maps.lua',
  '.contrib/.db/forever/.config/constants/maps.lua',
  '.contrib/.db/forever/.config/constants/timelines.lua',
];
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const ATT_NOTICE = 'Copyright (c) 2026 AllTheThings WoW Addon. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function get(url, as = 'text') {
  const response = await fetch(url, { headers: { 'User-Agent': 'wow-voice-guide-build', Accept: as === 'json' ? 'application/vnd.github+json' : '*/*' } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return as === 'json' ? response.json() : response.text();
}

// Minimal CSV (quoted fields) -> rows of strings.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function uiMaps(csv) {
  const [header, ...rows] = parseCsv(csv);
  const id = header.indexOf('ID'), name = header.indexOf('Name_lang');
  const maps = {};
  for (const r of rows) if (Number(r[id]) > 0) maps[Number(r[id])] = r[name];
  return maps;
}

// Where the files come from: a local checkout, or the GitHub tree at one commit.
async function source() {
  const local = arg('--att');
  if (local) {
    const root = path.resolve(local);
    const files = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.lua')) files.push(path.relative(root, full).split(path.sep).join('/'));
      }
    };
    walk(path.join(root, FOREVER_DIR));
    return { commit: 'local', files, read: async p => fs.readFileSync(path.join(root, p), 'utf8') };
  }
  const commit = (await get(`${API}/repos/${REPO}/commits/${BRANCH}`, 'json')).sha;
  const tree = await get(`${API}/repos/${REPO}/git/trees/${commit}?recursive=1`, 'json');
  const files = tree.tree.filter(t => t.type === 'blob' && t.path.endsWith('.lua')).map(t => t.path);
  const read = p => get(`${RAW}/${REPO}/${commit}/${p.split('/').map(encodeURIComponent).join('/')}`);
  return { commit, files, read };
}

// ATT's quest records -> the compact form the companion loads (bridge/questdb.js).
function compact(q) {
  const out = { n: q.name };
  if (q.lvl) out.l = q.lvl;
  if (q.faction) out.f = q.faction;
  if (q.races) out.r = q.races;
  if (q.classes) out.c = q.classes;
  if (q.pre && q.pre.length) out.pre = [...new Set(q.pre)];
  if (q.preNeed) out.pn = q.preNeed;
  if (q.alt) out.alt = q.alt;
  if (q.breadcrumb) out.b = 1;
  if (q.repeatable) out.rep = 1;
  if (q.skill) out.sk = q.skill;
  if (q.givers && q.givers.length) out.g = q.givers;
  if (q.maps) out.m = q.maps;
  if (q.event) out.ev = q.event;
  if (q.old) out.old = 1;
  return out;
}

function mergeQuest(into, q) {
  for (const key of ['name', 'lvl', 'faction', 'races', 'classes', 'preNeed', 'alt', 'breadcrumb', 'repeatable', 'skill', 'maps', 'event']) {
    if (into[key] === undefined && q[key] !== undefined) into[key] = q[key];
  }
  if (q.pre) into.pre = [...new Set([...(into.pre || []), ...q.pre])];
  const have = new Set((into.givers || []).map(g => JSON.stringify(g)));
  for (const g of q.givers || []) if (!have.has(JSON.stringify(g))) (into.givers = into.givers || []).push(g);
}

async function build() {
  const out = path.resolve(arg('--out') || path.join(__dirname, '..', 'bridge', 'data', 'forever-quests.json'));
  const src = await source();
  const maps = uiMaps(await get(`https://wago.tools/db2/UiMap/csv?build=${BUILD}`));
  const validMaps = new Set(Object.keys(maps).map(Number));
  const env = ATT.loadConstants(await Promise.all(CONSTANT_FILES.map(p => src.read(p).catch(() => ''))));
  const files = src.files
    .filter(p => p.startsWith(FOREVER_DIR) && !p.includes('/.config/'))
    .sort((a, b) => Number(a.includes('/zzOLD/')) - Number(b.includes('/zzOLD/')) || a.localeCompare(b));
  const quests = new Map(), npcs = {};
  const stats = { files: 0, oldFiles: 0, seen: 0, removed: 0, fromOld: 0 };
  for (const file of files) {
    const old = file.includes('/zzOLD/');
    const rel = file.slice(FOREVER_DIR.length);
    const parsed = ATT.parseFile(await src.read(file), env);
    const found = ATT.questsFromFile(parsed, { file: rel, maps: validMaps, old });
    stats[old ? 'oldFiles' : 'files']++;
    for (const [id, name] of Object.entries(found.npcs)) if (!npcs[id]) npcs[id] = name;
    for (const q of found.quests) {
      stats.seen++;
      if (!q.present) { stats.removed++; continue; }
      const have = quests.get(q.id);
      if (!have) { quests.set(q.id, q); if (old) stats.fromOld++; }
      else if (!have.old || old) mergeQuest(have, q);
    }
  }
  const usedMaps = new Set(), usedNpcs = new Set();
  const rows = {};
  for (const id of [...quests.keys()].sort((a, b) => a - b)) {
    const q = quests.get(id);
    rows[id] = compact(q);
    for (const g of q.givers || []) { if (g[0]) usedNpcs.add(g[0]); if (g[3]) usedMaps.add(g[3]); }
    for (const m of q.maps || []) usedMaps.add(m);
  }
  const db = {
    meta: {
      source: `AllTheThings WoW: Forever database (https://github.com/${REPO}, .contrib/.db/forever), converted by tools/build-quest-db.js`,
      license: 'MIT',
      notice: ATT_NOTICE,
      attCommit: src.commit,
      clientBuild: BUILD,
      generated: new Date().toISOString().slice(0, 10),
      counts: { quests: quests.size, withGiverCoords: Object.values(rows).filter(q => (q.g || []).some(g => g.length >= 4)).length, npcs: usedNpcs.size, ...stats },
    },
    maps: Object.fromEntries([...usedMaps].sort((a, b) => a - b).map(m => [m, maps[m]])),
    npcs: Object.fromEntries([...usedNpcs].sort((a, b) => a - b).filter(n => npcs[n]).map(n => [n, npcs[n]])),
    quests: rows,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // One quest per line: readable diffs when the data is rebuilt.
  const body = [
    '{',
    `"meta":${JSON.stringify(db.meta)},`,
    `"maps":${JSON.stringify(db.maps)},`,
    `"npcs":${JSON.stringify(db.npcs)},`,
    '"quests":{',
    Object.entries(db.quests).map(([id, q]) => `"${id}":${JSON.stringify(q)}`).join(',\n'),
    '}}',
    '',
  ].join('\n');
  fs.writeFileSync(out, body);
  console.log(`wrote ${out}: ${quests.size} quests (${db.meta.counts.withGiverCoords} with giver coordinates, ${stats.fromOld} from zzOLD), ${usedNpcs.size} NPCs, ${usedMaps.size} maps; ATT ${src.commit}`);
}

if (require.main === module) build().catch(e => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { parseCsv, uiMaps, compact, mergeQuest };
