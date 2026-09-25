'use strict';
// Reads AllTheThings (ATT) database source files -- Lua data written for ATT's
// own parser -- and pulls out the quests: id, name, quest givers with map
// coordinates, level, faction/race/class limits, prerequisites.
//
// It is not a Lua interpreter. It understands the subset those files use:
// ATT's "-- #if" preprocessor comments, tables, calls, constants and simple
// assignments; function bodies are skipped. Names come from the trailing
// comments ATT writes after ids (`q(3519, {	-- A Friend in Need`).
//
// Pure: tools/build-quest-db.js does the downloading, tests/questdb_test.js
// feeds it fixtures.

// ---------------------------------------------------------------------------
// Versions and the preprocessor
// ---------------------------------------------------------------------------

// ATT's forever.config: DataPatch 1.60.1.69893 and these PreProcessorTags.
const FOREVER = Object.freeze({
  version: [1, 60, 1, 69893],
  tags: new Set(['ANYCLASSIC', 'FOREVER', 'CAMELOT', 'CLASSIC', 'CRIEVE', 'EXPLORATION', 'IGNORE_ERRORS', 'OBJECTIVES', 'NOSIMPLIFY']),
});

const EXPANSIONS = Object.freeze({
  TBC: '2.0.1', WRATH: '3.0.2', CATA: '4.0.1', MOP: '5.0.4', WOD: '6.0.2', LEGION: '7.0.3',
  BFA: '8.0.1', SHADOWLANDS: '9.0.1', DF: '10.0.2', TWW: '11.0.2', MIDNIGHT: '12.0.0',
});

function parseVersion(text) {
  const named = EXPANSIONS[String(text).trim().toUpperCase()];
  const parts = String(named || text).trim().split(/[._]/).map(Number);
  return parts.every(Number.isFinite) && parts.length ? parts : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function evalCondition(expr, target = FOREVER) {
  const text = String(expr || '').trim();
  if (/\s+OR\s+/i.test(text)) return text.split(/\s+OR\s+/i).some(p => evalCondition(p, target));
  if (/\s+AND\s+/i.test(text)) return text.split(/\s+AND\s+/i).every(p => evalCondition(p, target));
  const not = text.match(/^NOT\s+(.+)$/i);
  if (not) return !evalCondition(not[1], target);
  const cmp = text.match(/^(BEFORE|AFTER)\s+(\S+)$/i);
  if (cmp) {
    const v = parseVersion(cmp[2]);
    if (!v) return false;
    const c = compareVersions(target.version, v);
    return cmp[1].toUpperCase() === 'BEFORE' ? c < 0 : c >= 0;
  }
  return target.tags.has(text.toUpperCase());
}

// Blank out lines in inactive "-- #if" branches (line numbers are kept).
function preprocess(source, target = FOREVER) {
  const stack = [];
  const active = () => stack.every(s => s.active);
  return String(source).split(/\r?\n/).map(line => {
    const d = line.match(/^\s*--\s*#(if|elseif|else|endif)\b\s*(.*)$/i);
    if (!d) return active() ? line : '';
    const kind = d[1].toLowerCase();
    if (kind === 'if') {
      const cond = evalCondition(d[2], target);
      stack.push({ active: cond, taken: cond });
    } else if (kind === 'elseif' && stack.length) {
      const top = stack[stack.length - 1];
      const cond = !top.taken && evalCondition(d[2], target);
      top.active = cond;
      top.taken = top.taken || cond;
    } else if (kind === 'else' && stack.length) {
      const top = stack[stack.length - 1];
      top.active = !top.taken;
      top.taken = true;
    } else if (kind === 'endif') stack.pop();
    return '';
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Tokens (line comments are kept per line: they carry ATT's names)
// ---------------------------------------------------------------------------

const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);

function tokenize(src) {
  const tokens = [];
  const comments = new Map(); // line -> text of the first line comment on it
  let i = 0, line = 1;
  const n = src.length;
  const longBracket = at => {
    const m = src.slice(at).match(/^\[(=*)\[/);
    return m ? m[1].length : -1;
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      const level = longBracket(i + 2);
      if (level >= 0) {
        const close = ']' + '='.repeat(level) + ']';
        const end = src.indexOf(close, i);
        const stop = end < 0 ? n : end + close.length;
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        i = stop;
        continue;
      }
      let end = src.indexOf('\n', i);
      if (end < 0) end = n;
      if (!comments.has(line)) comments.set(line, src.slice(i + 2, end).trim());
      i = end;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      tokens.push({ t: KEYWORDS.has(word) ? 'kw' : 'name', v: word, line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const m = src.slice(i).match(/^(0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
      tokens.push({ t: 'num', v: Number(m[1]), line });
      i += m[1].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, out = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          const e = src[j + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };
          if (map[e] !== undefined) { out += map[e]; j += 2; continue; }
          const dec = src.slice(j + 1).match(/^\d{1,3}/);
          if (dec) { out += String.fromCharCode(Number(dec[0])); j += 1 + dec[0].length; continue; }
          out += e; j += 2; continue;
        }
        if (src[j] === '\n') line++;
        out += src[j++];
      }
      tokens.push({ t: 'str', v: out, line });
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const level = longBracket(i);
      if (level >= 0) {
        const open = level + 2, close = ']' + '='.repeat(level) + ']';
        const end = src.indexOf(close, i + open);
        const stop = end < 0 ? n : end;
        const text = src.slice(i + open, stop);
        tokens.push({ t: 'str', v: text, line });
        for (const ch of text) if (ch === '\n') line++;
        i = stop + close.length;
        continue;
      }
    }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    if (three === '...') { tokens.push({ t: 'op', v: three, line }); i += 3; continue; }
    if (['..', '==', '~=', '<=', '>=', '::'].includes(two)) { tokens.push({ t: 'op', v: two, line }); i += 2; continue; }
    tokens.push({ t: 'op', v: c, line });
    i++;
  }
  tokens.push({ t: 'eof', v: '', line });
  return { tokens, comments };
}

// ---------------------------------------------------------------------------
// Parser: statements and expressions into plain JS values. A call becomes
// { call: 'name', args: [...], line }; an unknown name { name: 'X' }; a table
// { arr: [...], hash: {...}, lines: { key|index: line } }.
// ---------------------------------------------------------------------------

class Parser {
  constructor(tokens, env) {
    this.tokens = tokens;
    this.p = 0;
    this.env = env; // name -> value (constants and assignments so far)
    this.calls = []; // top-level call statements, in order
  }
  // A global or local assignment. Data assigned to a name (an instance built
  // as `X_INSTANCE = inst(...)`) is walked too, in case nothing uses it later.
  assign(name, value) {
    this.env.set(name, value);
    if (value && typeof value === 'object' && (value.call || value.arr)) this.calls.push(value);
  }
  peek(k = 0) { return this.tokens[this.p + k]; }
  next() { return this.tokens[this.p++]; }
  is(v, k = 0) { const t = this.peek(k); return (t.t === 'op' || t.t === 'kw') && t.v === v; }
  accept(v) { if (this.is(v)) { this.p++; return true; } return false; }
  expect(v) { if (!this.accept(v)) throw new Error(`line ${this.peek().line}: expected "${v}", got "${this.peek().v}"`); }

  // Skip a block that starts at the current keyword, up to its matching end.
  skipBlock() {
    let depth = 0, entered = false;
    for (;;) {
      const t = this.next();
      if (t.t === 'eof') return;
      if (t.t === 'kw' && ['function', 'if', 'do', 'repeat'].includes(t.v)) { depth++; entered = true; }
      else if (t.t === 'kw' && (t.v === 'end' || t.v === 'until')) {
        depth--;
        if (t.v === 'until') this.expr();
        if (entered && depth <= 0) return;
      }
    }
  }

  chunk() {
    while (this.peek().t !== 'eof') {
      const start = this.p;
      try { this.statement(); }
      catch { this.p = Math.max(start + 1, this.p); }
    }
    return this.calls;
  }

  statement() {
    const t = this.peek();
    if (this.accept(';')) return;
    if (t.t === 'kw') {
      if (t.v === 'local') {
        this.next();
        if (this.is('function')) { this.skipBlock(); return; }
        const names = [this.next().v];
        while (this.accept(',')) names.push(this.next().v);
        if (this.accept('=')) {
          const values = this.exprList();
          names.forEach((name, i) => { this.assign(name, values[i]); });
        }
        return;
      }
      if (['function', 'if', 'for', 'while', 'do', 'repeat'].includes(t.v)) { this.skipBlock(); return; }
      if (t.v === 'return') {
        this.next();
        if (!this.is('end') && this.peek().t !== 'eof') this.exprList();
        return;
      }
      this.next();
      return;
    }
    if (t.t === 'name' && this.is('=', 1)) {
      this.next(); this.next();
      this.assign(t.v, this.expr());
      return;
    }
    const target = this.suffixed();
    if (this.is('=') || this.is(',')) {
      const targets = [target];
      while (this.accept(',')) targets.push(this.suffixed());
      this.expect('=');
      const values = this.exprList();
      targets.forEach((tg, i) => { if (tg && tg.name) this.assign(tg.name, values[i]); });
      return;
    }
    if (target && target.call) this.calls.push(target);
  }

  exprList() {
    const list = [this.expr()];
    while (this.accept(',')) list.push(this.expr());
    return list;
  }

  expr(limit = 0) {
    const PREC = { or: 1, and: 2, '<': 3, '>': 3, '<=': 3, '>=': 3, '~=': 3, '==': 3, '..': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7, '^': 10 };
    let left;
    if (this.is('not') || this.is('-') || this.is('#')) {
      const op = this.next().v;
      const v = this.expr(8);
      left = op === '-' && typeof v === 'number' ? -v : op === 'not' ? { op: 'not', v } : { op, v };
    } else left = this.simple();
    for (;;) {
      const t = this.peek();
      const prec = (t.t === 'op' || t.t === 'kw') && PREC[t.v];
      if (!prec || prec <= limit) return left;
      this.next();
      const right = this.expr(t.v === '..' || t.v === '^' ? prec - 1 : prec);
      if (typeof left === 'number' && typeof right === 'number') {
        const r = { '+': left + right, '-': left - right, '*': left * right, '/': left / right }[t.v];
        if (r !== undefined) { left = r; continue; }
      }
      if (typeof left === 'string' && typeof right === 'string' && t.v === '..') { left = left + right; continue; }
      left = { op: t.v, a: left, b: right };
    }
  }

  simple() {
    const t = this.peek();
    if (t.t === 'num' || t.t === 'str') { this.next(); return t.v; }
    if (t.t === 'kw') {
      if (t.v === 'nil') { this.next(); return null; }
      if (t.v === 'true') { this.next(); return true; }
      if (t.v === 'false') { this.next(); return false; }
      if (t.v === 'function') { this.skipBlock(); return { func: true }; }
    }
    if (this.is('...')) { this.next(); return null; }
    if (this.is('{')) return this.table();
    return this.suffixed();
  }

  primary() {
    const t = this.peek();
    if (t.t === 'name') {
      this.next();
      return { ref: t.v, line: t.line };
    }
    if (this.accept('(')) {
      const v = this.expr();
      this.expect(')');
      return { value: v };
    }
    throw new Error(`line ${t.line}: unexpected "${t.v}"`);
  }

  // Names, fields, indexes and calls, resolved against the environment.
  suffixed() {
    const base = this.primary();
    let path = base.ref || null; // a dotted name while it stays one
    let value = base.ref ? undefined : base.value;
    const line = base.line;
    const resolve = () => {
      if (value !== undefined || !path) return value;
      if (this.env.has(path)) return this.env.get(path);
      const parts = path.split('.');
      let v = this.env.get(parts[0]);
      for (const k of parts.slice(1)) v = v && v.hash ? v.hash[k] : undefined;
      return v !== undefined ? v : { name: path };
    };
    for (;;) {
      if (this.is('.') && this.peek(1).t === 'name') {
        this.next();
        const key = this.next().v;
        if (path && value === undefined) path += '.' + key;
        else { const v = resolve(); value = v && v.hash ? v.hash[key] : null; path = null; }
      } else if (this.is('[') && !this.is('[', 1)) {
        this.next();
        const key = this.expr();
        this.expect(']');
        const v = resolve();
        value = v && v.hash && key in v.hash ? v.hash[key] : v && v.arr && typeof key === 'number' ? v.arr[key - 1] : null;
        path = null;
      } else if (this.is(':')) {
        this.next(); this.next();
        this.args();
        value = null; path = null;
      } else if (this.is('(') || this.is('{') || this.peek().t === 'str') {
        const args = this.args();
        const name = path && value === undefined ? path : '?';
        value = name === 'lvlsquish' && typeof args[0] === 'number' ? args[0] : { call: name, args, line };
        path = null;
      } else break;
    }
    if (path && value === undefined) return resolve();
    return value;
  }

  args() {
    if (this.peek().t === 'str') return [this.next().v];
    if (this.is('{')) return [this.table()];
    this.expect('(');
    const list = this.is(')') ? [] : this.exprList();
    this.expect(')');
    return list;
  }

  table() {
    this.expect('{');
    const t = { arr: [], hash: {}, lines: {} };
    while (!this.accept('}')) {
      const line = this.peek().line;
      if (this.is('[') && !this.is('[', 1)) {
        this.next();
        const key = this.expr();
        this.expect(']');
        this.expect('=');
        const v = this.expr();
        const k = typeof key === 'string' || typeof key === 'number' ? key : String(key && key.name);
        t.hash[k] = v;
        t.lines[k] = this.valueLine(line);
      } else if (this.peek().t === 'name' && this.is('=', 1)) {
        const key = this.next().v;
        this.next();
        const vLine = this.peek().line;
        t.hash[key] = this.expr();
        t.lines[key] = vLine;
      } else {
        const vLine = this.peek().line;
        t.arr.push(this.expr());
        t.lines[t.arr.length] = vLine;
      }
      if (!this.accept(',') && !this.accept(';')) { this.expect('}'); break; }
    }
    return t;
  }

  valueLine(fallback) {
    const prev = this.tokens[this.p - 1];
    return prev ? prev.line : fallback;
  }
}

// Parse one file. `env` (a Map) carries constants and earlier files' globals;
// assignments in this file are added to it.
function parseFile(source, env = new Map(), target = FOREVER) {
  const { tokens, comments } = tokenize(preprocess(source, target));
  const parser = new Parser(tokens, env);
  const calls = parser.chunk();
  return { calls, comments, env };
}

// ---------------------------------------------------------------------------
// Constants: map ids (MAP.X and bare X), TIMELINE strings
// ---------------------------------------------------------------------------

// Load constant files (ATT's Maps.lua, forever maps.lua, timelines.lua) into env.
function loadConstants(sources, env = new Map()) {
  for (const src of sources) parseFile(src, env);
  // forever maps.lua copies MAP.X to globals.
  const map = env.get('MAP');
  if (map && map.hash) for (const [k, v] of Object.entries(map.hash)) if (typeof v === 'number') env.set(k, v);
  return env;
}

// ---------------------------------------------------------------------------
// Timelines: is the quest in the game at the target version?
// ---------------------------------------------------------------------------

const NAMED_EVENTS = Object.freeze({
  REMOVED_WITH_CATA: ['removed', '4.0.1'],
  REMOVED_WITH_RERELEASE: ['removed', '1.13.2'],
  ADDED_WITH_RERELEASE: ['added', '1.13.2'],
  REMOVED_FROM_GAME: ['removed', '0.0.1'],
  REMOVED_TBC_PHASE_TWO: ['removed', '2.1.0'],
});

function timelineEvent(value) {
  if (typeof value === 'string') {
    const m = value.match(/^(added|removed|created|deleted)\s+([\d.]+)/i);
    return m ? { kind: m[1].toLowerCase(), v: parseVersion(m[2]) } : null;
  }
  const name = value && value.name ? value.name.replace(/^TIMELINE\./, '') : '';
  if (NAMED_EVENTS[name]) return { kind: NAMED_EVENTS[name][0], v: parseVersion(NAMED_EVENTS[name][1]) };
  const m = name.match(/^(ADDED|REMOVED|CREATED|DELETED)_(\d+)_(\d+)_(\d+)/);
  return m ? { kind: m[1].toLowerCase(), v: [Number(m[2]), Number(m[3]), Number(m[4])] } : null;
}

function inTimeline(timeline, target = FOREVER) {
  const values = timeline && timeline.arr ? timeline.arr : timeline ? [timeline] : [];
  const events = values.map(timelineEvent).filter(e => e && e.v).sort((a, b) => compareVersions(a.v, b.v));
  if (!events.length) return true;
  let present = !['added', 'created'].includes(events[0].kind);
  for (const e of events) {
    if (compareVersions(e.v, target.version) > 0) break;
    present = e.kind === 'added' || e.kind === 'created';
  }
  return present;
}

// ---------------------------------------------------------------------------
// Walking a file's calls for quests
// ---------------------------------------------------------------------------

const ALLIANCE = ['HUMAN', 'DWARF', 'NIGHTELF', 'GNOME', 'DRAENEI', 'WORGEN', 'VOIDELF', 'LIGHTFORGED', 'DARKIRON', 'KULTIRAN', 'MECHAGNOME'];
const HORDE = ['ORC', 'UNDEAD', 'TAUREN', 'TROLL', 'BLOODELF', 'GOBLIN', 'NIGHTBORNE', 'HIGHMOUNTAIN', 'MAGHAR', 'ZANDALARI', 'VULPERA'];
const CLASSES = ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'DEATHKNIGHT', 'SHAMAN', 'MAGE', 'WARLOCK', 'MONK', 'DRUID', 'DEMONHUNTER', 'EVOKER'];
const WRAPPERS = new Set(['bubbleDown', 'bubbleDownSelf', 'bubbleDownFiltered', 'bubbleDownClassicRep', 'applyclassicphase', 'applyDataSelf', 'sharedData', 'sharedDataSelf', 'removeclassicphase', 'filter', 'header', 'n', 'root', 'e']);

function listOf(v) {
  if (v == null) return [];
  if (v.arr) return v.arr;
  return [v];
}

function names(v) {
  return listOf(v).map(x => (x && x.name ? x.name : typeof x === 'string' ? x : null)).filter(Boolean);
}

// Races/classes values -> { faction: 'A'|'H'|undefined, races: [..] | undefined }
function raceLimit(v) {
  const list = names(v);
  if (!list.length) return {};
  if (list.includes('ALLIANCE_ONLY')) return { faction: 'A' };
  if (list.includes('HORDE_ONLY')) return { faction: 'H' };
  const races = list.filter(r => ALLIANCE.includes(r) || HORDE.includes(r));
  if (!races.length) return {};
  const faction = races.every(r => ALLIANCE.includes(r)) ? 'A' : races.every(r => HORDE.includes(r)) ? 'H' : undefined;
  return { faction, races };
}

function classLimit(v) {
  const list = names(v).filter(c => CLASSES.includes(c));
  return list.length ? list : undefined;
}

function commentName(comments, line) {
  const text = comments.get(line);
  if (!text) return '';
  return text.replace(/^[\s-]+/, '').split(/\s+--\s+/)[0].trim().slice(0, 90);
}

function numbersIn(v) {
  return listOf(v).filter(x => typeof x === 'number');
}

// { arr: [x, y, map] } -> [x, y, mapId] when the map is one of `maps`.
function coordOf(v, maps) {
  const a = v && v.arr;
  if (!a || typeof a[0] !== 'number' || typeof a[1] !== 'number') return null;
  const mapId = typeof a[2] === 'number' ? a[2] : null;
  if (!mapId || (maps && !maps.has(mapId))) return null;
  return [Math.round(a[0] * 10) / 10, Math.round(a[1] * 10) / 10, mapId];
}

// Quest givers from a quest (or its allianceQuestData/hordeQuestData) table.
function giversOf(t, comments, maps, npcs, faction) {
  const out = [];
  const ids = [];
  if (typeof t.hash.qg === 'number') ids.push([t.hash.qg, t.lines.qg]);
  const qgs = t.hash.qgs;
  if (qgs && qgs.arr) qgs.arr.forEach((id, i) => { if (typeof id === 'number') ids.push([id, qgs.lines[i + 1]]); });
  for (const [id, line] of ids) {
    const name = commentName(comments, line);
    if (name && !npcs[id]) npcs[id] = name;
  }
  const coords = [];
  const one = coordOf(t.hash.coord, maps);
  if (one) coords.push(one);
  for (const c of listOf(t.hash.coords)) { const p = coordOf(c, maps); if (p) coords.push(p); }
  const pairUp = ids.length === coords.length;
  if (pairUp) ids.forEach(([id], i) => out.push([id, ...coords[i]]));
  else {
    for (const [id] of ids) out.push([id]);
    for (const c of coords) out.push([0, ...c]);
  }
  if (faction) for (const g of out) g[4] = faction;
  return out;
}

// All quests in one parsed file, with inherited header context.
function questsFromFile(parsed, { file = '', maps = null, target = FOREVER, old = false } = {}) {
  const { calls, comments } = parsed;
  const quests = [];
  const npcs = {};
  const seen = new Set();
  const event = /(^|\/)holidays\//.test(file) ? file.replace(/^.*\//, '').replace(/\.lua$/, '').replace(/\b\w/g, c => c.toUpperCase()) : undefined;

  const emit = (id, data, ctx, line) => {
    const t = data && data.hash ? data : { arr: [], hash: {}, lines: {} };
    const timeline = [...listOf(ctx.timeline), ...listOf(t.hash.timeline)];
    const q = { id, name: commentName(comments, line) };
    q.present = inTimeline({ arr: timeline }, target);
    const lvl = t.hash.lvl;
    if (typeof lvl === 'number') q.lvl = lvl;
    else if (lvl && lvl.arr && typeof lvl.arr[0] === 'number') q.lvl = lvl.arr[0];
    const races = raceLimit(t.hash.races !== undefined ? t.hash.races : ctx.races);
    if (races.faction) q.faction = races.faction;
    if (races.races) q.races = races.races;
    const classes = classLimit(t.hash.classes !== undefined ? t.hash.classes : ctx.classes);
    if (classes) q.classes = classes;
    const pre = [...numbersIn(t.hash.sourceQuest), ...numbersIn(t.hash.sourceQuests)];
    if (pre.length) q.pre = pre;
    if (typeof t.hash.sourceQuestNumRequired === 'number') q.preNeed = t.hash.sourceQuestNumRequired;
    const alt = numbersIn(t.hash.altQuests);
    if (alt.length) q.alt = alt;
    if (t.hash.isBreadcrumb === true) q.breadcrumb = true;
    if (t.hash.repeatable === true || t.hash.isDaily === true || t.hash.isWeekly === true || t.hash.isYearly === true) q.repeatable = true;
    if (typeof t.hash.requireSkill === 'number') q.skill = t.hash.requireSkill;
    q.givers = giversOf(t, comments, maps, npcs);
    for (const [key, faction] of [['allianceQuestData', 'A'], ['hordeQuestData', 'H']]) {
      const side = t.hash[key];
      if (!side || !side.hash) continue;
      q.givers.push(...giversOf(side, comments, maps, npcs, faction));
      for (const id of [...numbersIn(side.hash.sourceQuest), ...numbersIn(side.hash.sourceQuests)]) (q.pre = q.pre || []).push(id);
    }
    const mapList = numbersIn(t.hash.maps).filter(m => !maps || maps.has(m));
    if (!q.givers.some(g => g.length >= 4)) {
      if (mapList.length) q.maps = mapList;
      else if (ctx.map) q.maps = [ctx.map];
    }
    if (event) q.event = event;
    if (old) q.old = true;
    quests.push(q);
  };

  // The quest table inside wrappers like bubbleDown({..}, { ... }).
  const unwrap = (v, ctx) => {
    let data = v, inner = { ...ctx };
    while (data && data.call && WRAPPERS.has(data.call)) {
      const props = data.args.find(a => a && a.hash && a !== data.args[data.args.length - 1]);
      if (props) inner = withProps(inner, props);
      data = data.args[data.args.length - 1];
    }
    return { data, ctx: inner };
  };

  const withProps = (ctx, props) => {
    const next = { ...ctx };
    if (props.hash.timeline !== undefined) next.timeline = [...listOf(ctx.timeline), ...listOf(props.hash.timeline)];
    if (props.hash.races !== undefined) next.races = props.hash.races;
    if (props.hash.classes !== undefined) next.classes = props.hash.classes;
    return next;
  };

  const walk = (v, ctx, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 60) return;
    if (seen.has(v)) return;
    seen.add(v);
    if (v.call) {
      const name = v.call;
      if (name === 'q' && typeof v.args[0] === 'number') {
        const { data, ctx: inner } = unwrap(v.args[1], ctx);
        emit(v.args[0], data, inner, v.line);
        if (data && data.hash) walk(data.hash.groups || data.hash.g, withProps(inner, data), depth + 1);
        return;
      }
      if (name === 'bubbleDown' || name === 'bubbleDownSelf' || name === 'bubbleDownFiltered' || name === 'bubbleDownClassicRep') {
        const props = v.args[0] && v.args[0].hash ? v.args[0] : null;
        walk(v.args[v.args.length - 1], props ? withProps(ctx, props) : ctx, depth + 1);
        return;
      }
      if (name === 'cl') {
        const cls = v.args[0] && v.args[0].name;
        const next = CLASSES.includes(cls) ? { ...ctx, classes: { name: cls } } : ctx;
        for (const a of v.args.slice(1)) walk(a, next, depth + 1);
        return;
      }
      if (name === 'm' || name === 'maproot' || name === 'inst' || name === 'mapped') {
        let next = ctx;
        for (const a of v.args) if (typeof a === 'number' && (!maps || maps.has(a))) next = { ...next, map: a };
        for (const a of v.args) walk(a, next, depth + 1);
        return;
      }
      for (const a of v.args) walk(a, ctx, depth + 1);
      return;
    }
    if (v.arr) {
      const next = v.hash && (v.hash.timeline !== undefined || v.hash.races !== undefined || v.hash.classes !== undefined) ? withProps(ctx, v) : { ...ctx };
      if (v.hash && typeof v.hash.mapID === 'number' && (!maps || maps.has(v.hash.mapID))) next.map = v.hash.mapID;
      for (const a of v.arr) walk(a, next, depth + 1);
      if (v.hash) {
        walk(v.hash.groups, next, depth + 1);
        walk(v.hash.g, next, depth + 1);
        // { allianceQuestData = q(...), hordeQuestData = q(...) }: one quest per faction.
        for (const [key, value] of Object.entries(v.hash)) {
          if (!value || !value.call) continue;
          const side = key === 'allianceQuestData' ? 'ALLIANCE_ONLY' : key === 'hordeQuestData' ? 'HORDE_ONLY' : null;
          walk(value, side ? { ...next, races: { name: side } } : next, depth + 1);
        }
      }
    }
  };

  for (const call of calls) walk(call, {});
  return { quests, npcs };
}

module.exports = {
  FOREVER, parseVersion, compareVersions, evalCondition, preprocess, tokenize,
  parseFile, loadConstants, inTimeline, questsFromFile, raceLimit,
};
