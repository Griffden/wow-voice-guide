// Runs the real addon Lua (Codec.lua + WoWClaude.lua) in a Lua VM with a stub
// WoW API (wow_stub.lua) and drives it through a session: login, hello, a sent
// message read back off the pixel strip, a reply delivered through a slot, the
// bridge's default folder, a permission denial with Allow, and a restore.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const ADDON = path.join(__dirname, '..', 'addon', 'WoWClaude');
const CELLS_PER_ROW = 200;

function newVM() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  // Evaluate an expression and bring it back as a string (or nil).
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  for (const f of ['Codec.lua', 'GameState.lua', 'Inbox.lua', 'WoWClaude.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWClaude');
  return { run, evaluate, num };
}

// Read the strip the addon drew, exactly like capture.ps1: 3 bits per cell,
// [C7 1A] [id] [len] [payload] [fletcher]. Returns { id, text } or null.
function decodeStrip(vm) {
  if (vm.evaluate('WoWClaudeStrip and WoWClaudeStrip.shown') !== 'true') return null;
  vm.run(`
    local parts = {}
    for _, t in ipairs(WoWClaudeStrip.textures) do
      if t.shown and t.color then
        local c, r = math.floor(t.x / 4), math.floor(-t.y / 4)
        local v = (t.color[1] >= 0.5 and 4 or 0) + (t.color[2] >= 0.5 and 2 or 0) + (t.color[3] >= 0.5 and 1 or 0)
        parts[#parts + 1] = (r * ${CELLS_PER_ROW} + c) .. ":" .. v
      end
    end
    RESULT = table.concat(parts, ",")`);
  const cells = [];
  for (const p of vm.evaluate('RESULT').split(',')) { const [i, v] = p.split(':').map(Number); cells[i] = v; }
  const bytes = [];
  let acc = 0, nbits = 0;
  for (let i = 0; i < cells.length; i++) {
    acc = (acc << 3) | (cells[i] || 0); nbits += 3;
    while (nbits >= 8) { bytes.push((acc >> (nbits - 8)) & 0xff); nbits -= 8; acc &= (1 << nbits) - 1; }
  }
  assert.equal(bytes[0], 0xc7); assert.equal(bytes[1], 0x1a);
  const id = bytes[2] * 256 + bytes[3];
  const len = bytes[4] * 256 + bytes[5];
  let s1 = 0, s2 = 0;
  for (let k = 2; k < 6 + len; k++) { s1 = (s1 + bytes[k]) % 255; s2 = (s2 + s1) % 255; }
  assert.equal(bytes[6 + len], s1, 'fletcher s1'); assert.equal(bytes[7 + len], s2, 'fletcher s2');
  return { id, text: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8') };
}

function stripRecords(vm) {
  const frame = decodeStrip(vm);
  if (!frame) return [];
  return frame.text.split('\x1E').map(r => {
    const p = r.split('\x1F');
    const flags = p[4].split(';');
    const withCtx = flags.includes('c') || flags.includes('s'); // field 7 is the game context (c) or state sections (s)
    const rec = { session: p[0], chat: p[1], id: Number(p[2]), cwd: p[3], flags: p[4], name: p[5], text: p.slice(withCtx ? 7 : 6).join('\x1F') };
    if (flags.includes('c')) rec.ctx = p[6];
    if (flags.includes('s')) rec.state = p[6];
    return rec;
  });
}

// Make the next LoadAddOn deliver this slot data (a Lua table literal body).
function nextSlot(vm, luaBody) {
  vm.run(`STUB.onLoadAddOn = function(name) WoWClaude_SlotData = ${luaBody} end`);
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "WoWClaude")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
}

// Let the bridge answer the login hello: its slot carries a fresh clock, which is
// what makes the addon consider itself connected (Send is gated on that).
function connect(vm) {
  vm.run('STUB.RunTimers()'); // C_Timer.After(3, SayHello)
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // hello poll 5 s later
  assert.equal(vm.evaluate('WoWClaude.IsConnected()'), 'true', 'connected after the hello slot');
}

test('addon loads, builds its UI and creates a first chat', () => {
  const vm = newVM();
  login(vm);
  assert.equal(vm.num('#WoWClaudeDB.chats'), 1);
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].name'), 'Chat 1');
  assert.equal(vm.evaluate('WoWClaudeFrame ~= nil'), 'true');
  assert.equal(vm.evaluate('WoWClaudeMini ~= nil'), 'true');
  assert.equal(vm.num('#STUB.tickers'), 1);
  assert.equal(vm.evaluate('SlashCmdList.WOWCLAUDE ~= nil'), 'true');
  assert.equal(vm.evaluate('SlashCmdList.CLAUDEASK ~= nil'), 'true');
});

test('hello goes out on the strip after login', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()'); // C_Timer.After(3, SayHello)
  const recs = stripRecords(vm);
  assert.equal(recs.length, 1, 'game state waits until the bridge has answered');
  assert.equal(recs[0].flags, 'h;vol=125', 'a hello carries the saved voice volume');
  assert.equal(recs[0].text, '');
  assert.equal(recs[0].session, vm.evaluate('WoWClaudeDB.session'));
});

// Every game state section on the strip, merged in record order like the bridge does.
function stateOnStrip(vm) {
  const sections = {};
  const records = stripRecords(vm).filter(r => r.state !== undefined);
  for (const rec of records) {
    for (const part of rec.state.split('\x1C')) {
      const [key, ...rest] = part.split('\x1D');
      if (key === '*') { for (const k of Object.keys(sections)) delete sections[k]; sections['*'] = true; continue; }
      sections[key] = rest.join('\x1D');
    }
  }
  return { sections, records };
}

// Let every section record count as delivered (a few seconds on screen).
function deliverState(vm) {
  vm.run('STUB.now = STUB.now + 4; STUB.Tick()');
}

test('after the hello, every game state section goes out in section records, then only what changes', () => {
  const vm = newVM();
  vm.run(`
    STUB.quests = { { questID = 94946, title = "The Magical City of Dalaran" } }
    STUB.questObjectives[94946] = { { text = "Talk to Dalaran City Guide", finished = false } }
  `);
  login(vm);
  connect(vm);
  vm.run('STUB.RunTimers(); STUB.Tick()');
  const { sections, records } = stateOnStrip(vm);
  assert.ok(records.every(r => r.flags === 's' && r.text === ''), 'section records carry no text');
  assert.ok(records.every(r => r.state.length <= 1600), 'each record stays within its budget');
  assert.equal(sections['*'], true, 'a full resend replaces whatever the bridge had');
  assert.deepEqual(sections.char.split('\n'), [
    'Game: World of Warcraft: Forever (client 1.60.1.69913, interface 16001)',
    'Character: Testchar on Test Realm, level 23 Night Elf Hunter (Alliance), guild <Test Guild>',
    'Hearthstone: Darkshire',
  ]);
  assert.equal(sections.prog, 'Money: 1g 23s 45c; XP: 1234/5000');
  assert.equal(sections.loc, 'Location: Duskwood - Darkshire\nPosition: 45.2, 67.8 (map 1431)');
  assert.equal(sections.talents, 'Specialization: Beast Mastery\nTalents (4 points): Improved Aspect of the Hawk 3, Bestial Swiftness', 'spent talents from C_Traits, unspent nodes left out');
  assert.equal(sections.prof, 'Professions: Skinning 75/75, First Aid 40/75', 'professions from C_SkillInfo');
  assert.match(sections.quest, /^Only quest: The Magical City of Dalaran \(id 94946\)\nObjective: Talk to Dalaran City Guide$/);
  assert.equal(sections.quests, 'Quest log (1): The Magical City of Dalaran (#94946) [Talk to Dalaran City Guide]');
  assert.equal(sections.target, '', 'empty sections go out too, so the bridge drops stale ones');
  assert.equal(sections.done, '7 completed in 1 chunks');
  assert.equal(sections['done.1'], '1~2,2,2~1,lj', 'runs of ids, base 36 deltas');
  // Delivered: the records leave the strip after a few seconds on screen.
  deliverState(vm);
  assert.equal(stateOnStrip(vm).records.length, 0);
  // A zone change sends the location section alone.
  vm.run('STUB.zone = "Elwynn Forest"; STUB.subzone = ""; STUB.posX = 0.1; STUB.FireEvent("ZONE_CHANGED_NEW_AREA"); STUB.now = STUB.now + 2; STUB.RunTimers()');
  let next = stateOnStrip(vm);
  assert.deepEqual(Object.keys(next.sections), ['loc']);
  assert.equal(next.sections.loc, 'Location: Elwynn Forest\nPosition: 10.0, 67.8 on Duskwood (map 1431)', 'the map name shows when it differs from the zone');
  deliverState(vm);
  // An unchanged section is not sent again.
  vm.run('STUB.FireEvent("PLAYER_MONEY"); STUB.now = STUB.now + 31; STUB.Tick()');
  assert.equal(stateOnStrip(vm).records.length, 0);
  // Walking a few map units re-sends the position on the next movement check.
  vm.run('STUB.posX = 0.2; STUB.now = STUB.now + 21; STUB.Tick(); STUB.RunTimers(); STUB.Tick()');
  next = stateOnStrip(vm);
  assert.match(next.sections.loc, /Position: 20\.0, 67\.8/);
});

test('a question goes out right behind the state it needs, and context off clears the bridge', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('STUB.RunTimers(); STUB.Tick()');
  deliverState(vm);
  vm.run('STUB.posX = 0.5; WoWClaude.Send("where am I")');
  const recs = stripRecords(vm);
  const question = recs.find(r => r.text === 'where am I');
  assert.equal(question.flags, '', 'the question itself carries no context');
  const state = recs.find(r => r.state !== undefined);
  assert.ok(state.id < question.id, 'the state record is read first');
  assert.match(state.state, /loc\x1DLocation: Duskwood - Darkshire\nPosition: 50\.0, 67\.8/);
  assert.equal(vm.evaluate('WoWClaudeDB.outbox.ctx'), null, 'pixel mode keeps the outbox free of context');
  deliverState(vm);
  // Off: one record clearing everything, and nothing more while it stays off.
  vm.run('SlashCmdList.WOWCLAUDE("context off")');
  const off = stateOnStrip(vm);
  assert.deepEqual(off.records.map(r => r.state), ['*\x1D']);
  assert.equal(vm.evaluate('WoWClaudeDB.settings.context'), 'false');
  assert.ok(vm.evaluate('WoWClaudeDB.chats[1].history[#WoWClaudeDB.chats[1].history].text').includes('Game context is OFF'));
  deliverState(vm);
  vm.run('STUB.FireEvent("ZONE_CHANGED_NEW_AREA"); STUB.RunTimers(); STUB.Tick()');
  assert.equal(stateOnStrip(vm).records.length, 0);
  // On: everything again.
  vm.run('SlashCmdList.WOWCLAUDE("context on")');
  const on = stateOnStrip(vm);
  assert.equal(on.sections['*'], true);
  assert.match(on.sections.char, /Character: Testchar/);
  assert.ok(vm.evaluate('WoWClaudeDB.chats[1].history[#WoWClaudeDB.chats[1].history].text').includes('Game context is ON'));
});

test('quest context: the focused quest in full, the log compact with completion state', () => {
  const vm = newVM();
  vm.run(`
    STUB.quests = {
      { isHeader = true, title = "Dalaran" },
      { questID = 94946, title = "The Magical City of Dalaran", instructions = "Take the skycutter ship.", description = "Meet the guide.", completion = "You made it." },
      { questID = 123, title = "Other Quest" },
    }
    STUB.selectedQuest = 94946
    STUB.trackedQuest = 123
    STUB.readyQuests[94946] = true
    STUB.waypointText[94946] = "Return to Archmage Khadgar"
    STUB.questObjectives[94946] = { { text = "Talk to Dalaran City Guide", finished = true } }
    STUB.questObjectives[123] = { { text = "0/8 Wolf Meat", finished = false }, { text = "1/1 Tooth", finished = true } }
  `);
  const context = vm.evaluate('WoWClaude.GameContext()');
  assert.match(context, /Selected quest: The Magical City of Dalaran \(id 94946\)\nStatus: objectives complete, ready to turn in\nObjective: Talk to Dalaran City Guide \(complete\)\nNext step: Return to Archmage Khadgar\nQuest instructions: Take the skycutter ship\.\nTurn-in text: You made it\.\nQuest description: Meet the guide\./);
  assert.match(context, /Quest log \(2\): The Magical City of Dalaran \(#94946\) \[ready to turn in\]; Other Quest \(#123\) \[0\/8 Wolf Meat\]/);
  assert.match(context, /Completed quests: 7/);
  vm.run('STUB.selectedQuest = 0; STUB.trackedQuest = 0');
  assert.doesNotMatch(vm.evaluate('WoWClaude.GameContext()'), /(?:Selected|Tracked|Only) quest:/);
  vm.run('STUB.quests[3] = nil');
  assert.match(vm.evaluate('WoWClaude.GameContext()'), /Only quest: The Magical City of Dalaran/);
});

test('NPC dialogs, the target, flight paths, gear and turn-ins become sections as their events fire', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('STUB.RunTimers(); STUB.Tick()');
  deliverState(vm);
  // Gossip is read while the frame is open.
  vm.run(`
    STUB.npcName = "Marshal Dughan"
    STUB.gossip = { text = "Ach, it's hard enough keeping order.", available = { { title = "Wolves Across the Border", questID = 33 } },
      active = { { title = "The Fargodeep Mine", questID = 62, isComplete = true } }, options = { { name = "I want to browse your goods." } } }
    STUB.FireEvent("GOSSIP_SHOW"); STUB.gossip = nil; STUB.now = STUB.now + 6; STUB.RunTimers()`);
  let s = stateOnStrip(vm).sections;
  assert.equal(s.npc, [
    'Talking to: Marshal Dughan',
    "Says: Ach, it's hard enough keeping order.",
    'Offers quests: Wolves Across the Border (#33)',
    'Your quests with this NPC: The Fargodeep Mine (#62) [complete]',
    'Dialog options: I want to browse your goods.',
  ].join('\n'));
  deliverState(vm);
  vm.run(`STUB.questDialog = { title = "Wolves Across the Border", id = 33, text = "Those wolves are a menace.", objective = "Bring 8 Tough Wolf Meat." }
    STUB.FireEvent("QUEST_DETAIL"); STUB.now = STUB.now + 6; STUB.RunTimers()`);
  s = stateOnStrip(vm).sections;
  assert.equal(s.npc, 'Talking to: Marshal Dughan\nOffers quest: Wolves Across the Border (#33)\nQuest text: Those wolves are a menace.\nObjectives: Bring 8 Tough Wolf Meat.');
  deliverState(vm);
  // The target: who, never how healthy.
  vm.run(`STUB.target = { name = "Hogger", level = 11, classification = "elite", creatureType = "Humanoid", reaction = 2, guid = "Creature-0-1-2-3-448-0000ABCD" }
    STUB.FireEvent("PLAYER_TARGET_CHANGED"); STUB.now = STUB.now + 6; STUB.RunTimers()`);
  s = stateOnStrip(vm).sections;
  assert.equal(s.target, 'Target: Hogger, level 11 elite Humanoid, hostile (npc 448)');
  deliverState(vm);
  // Flight paths are cached when the flight map opens.
  vm.run(`STUB.taxiNodes = { { name = "Rut'theran Village, Teldrassil", state = 0 }, { name = "Auberdine, Darkshore", state = 1 }, { name = "Astranaar, Ashenvale", state = 2 } }
    STUB.FireEvent("TAXIMAP_OPENED"); STUB.now = STUB.now + 6; STUB.RunTimers()`);
  s = stateOnStrip(vm).sections;
  assert.equal(s.taxi, "Known flight paths (2): Auberdine, Darkshore; Rut'theran Village, Teldrassil");
  deliverState(vm);
  // Gear: names, item levels, low durability, bag space.
  vm.run(`STUB.gear = { [5] = { link = "|cff1eff00|Hitem:2140|h[Fine Chestpiece]|h|r", cur = 9, max = 60 }, [16] = { link = "|Hitem:2|h[Old Sword]|h", cur = 50, max = 50 } }
    STUB.ilvl = { ["|cff1eff00|Hitem:2140|h[Fine Chestpiece]|h|r"] = 19 }
    STUB.avgIlvl = 14.6; STUB.freeSlots = 2
    STUB.FireEvent("PLAYER_EQUIPMENT_CHANGED"); STUB.now = STUB.now + 6; STUB.RunTimers()`);
  s = stateOnStrip(vm).sections;
  assert.equal(s.gear, 'Average item level: 15\nLow durability: Chest 15%\nBags: 2 of 16 slots free\nEquipped: Chest Fine Chestpiece (19); Main hand Old Sword');
  deliverState(vm);
  // A turn-in goes out as a small delta, not the whole completed list.
  vm.run('STUB.FireEvent("QUEST_TURNED_IN", 62, 100, 0); STUB.now = STUB.now + 6; STUB.RunTimers()');
  s = stateOnStrip(vm).sections;
  assert.equal(s['done.new'], '1q');
  assert.equal(s['done.1'], undefined);
  assert.equal(vm.evaluate('STUB.healthRead'), null, 'no health was ever read');
});

test('completed quest ids compress into runs and split into chunks that decode on their own', () => {
  const vm = newVM();
  vm.run('CHUNKS, COUNT = WoWClaude_State.EncodeIds({ 10, 11, 12, 13, 50, 9000, 9001, 50 }, 1000)');
  assert.equal(vm.evaluate('COUNT'), '7');
  assert.equal(vm.evaluate('table.concat(CHUNKS, "|")'), 'a~3,11,6wm~1');
  vm.run('local ids = {} for i = 1, 3000, 2 do ids[#ids + 1] = i end CHUNKS = WoWClaude_State.EncodeIds(ids, 200)');
  assert.ok(vm.num('#CHUNKS') > 5);
  vm.run('OK = true for _, c in ipairs(CHUNKS) do if #c > 200 then OK = false end end');
  assert.equal(vm.evaluate('OK'), 'true');
  assert.match(vm.evaluate('CHUNKS[2]'), /^[0-9a-z]{2,},2,2/, 'each chunk starts with an absolute id');
});

test('a shift-clicked link lands in the focused input and is sent as its name plus tooltip', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const link = '|cff1eff00|Hitem:2140:0:0:0:0:0:0:0:60:0:0|h[Fine Longsword]|h|r';
  vm.run(`STUB.tooltips["item:2140:0:0:0:0:0:0:0:60:0:0"] = { "Fine Longsword", { "Main Hand", "Sword" }, { "17 - 33 Damage", "Speed 2.70" }, "Requires Level 14" }`);
  // Without focus the link is left alone (shift-click keeps its normal meaning).
  vm.run(`WoWClaudeInput:SetText("is this good for me? "); WoWClaudeInput:ClearFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('WoWClaudeInput:GetText()'), 'is this good for me? ');
  // The client's own path (bags, spellbook, quest log all end here): ChatFrameUtil.InsertLink.
  vm.run(`WoWClaudeInput:SetFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('WoWClaudeInput:GetText()'), 'is this good for me? ' + link);
  // The old global name is not hooked as well, so nothing is inserted twice.
  vm.run(`ChatEdit_InsertLink("${link}")`);
  assert.equal(vm.evaluate('WoWClaudeInput:GetText()'), 'is this good for me? ' + link + link, 'the alias reaches the one hook exactly once');
  vm.run(`WoWClaudeInput:SetText("is this good for me? ${link}")`);
  vm.run('WoWClaude.SendFromInput()');
  const expected = [
    'is this good for me? [Fine Longsword]',
    '',
    '--- Linked from the game ---',
    '[Fine Longsword] item 2140 (Uncommon)',
    '  Fine Longsword',
    '  Main Hand  Sword',
    '  17 - 33 Damage  Speed 2.70',
    '  Requires Level 14',
  ].join('\n');
  const rec = stripRecords(vm).find(r => r.text.startsWith('is this good'));
  assert.equal(rec.text, expected);
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].history[#WoWClaudeDB.chats[1].history].text'), expected, 'the transcript shows what was sent');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].name'), 'Is this good for me');
  // Bare links (no colour) and repeated links: one block each, tooltip or not.
  vm.run('RESULT = (WoWClaude.ExpandLinks("x |Hspell:1978|h[Serpent Sting]|h y |Hspell:1978|h[Serpent Sting]|h"))');
  assert.equal(vm.evaluate('RESULT'), 'x [Serpent Sting] y [Serpent Sting]\n\n--- Linked from the game ---\n[Serpent Sting] spell 1978');
  vm.run('RESULT, COUNT = WoWClaude.ExpandLinks("plain text | with a pipe")');
  assert.equal(vm.evaluate('RESULT'), 'plain text | with a pipe');
  assert.equal(vm.evaluate('COUNT'), '0');
});

test('deleting a chat tells the bridge to forget it, and a restore never brings it back', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWClaude.NewChat("Second")');
  assert.equal(vm.num('#WoWClaudeDB.chats'), 2);
  const gone = vm.evaluate('WoWClaudeDB.chats[2].id');
  vm.run(`WoWClaude.DeleteChat("${gone}")`);
  assert.equal(vm.num('#WoWClaudeDB.chats'), 1);
  // A forget record for that chat is on the strip and remembered until acked.
  const rec = stripRecords(vm).find(r => r.flags === 'd');
  assert.ok(rec, 'forget record on the strip');
  assert.equal(rec.chat, gone);
  assert.equal(rec.text, '');
  assert.equal(vm.evaluate(`WoWClaudeDB.forget["${gone}"] ~= nil`), 'true');
  // A restore that still lists the chat is ignored for it.
  const token = vm.evaluate('WoWClaudeDB.session');
  nextSlot(vm, `{ now = time(), cwd = "", replies = {}, restore = { token = "${token}", chats = { { id = "${gone}", name = "Second", cwd = "", messages = { { role = "user", text = "old", id = 1, t = 1 } } } } } }`);
  vm.run('WoWClaude.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#WoWClaudeDB.chats'), 1, 'deleted chat not restored');
  // The bridge acks the forget record: it leaves the strip and the memory.
  const slot = String(rec.id).padStart(3, '0');
  vm.run(`STUB.sounds["Interface\\\\AddOns\\\\WoWClaude\\\\ack\\\\${slot}.wav"] = true; STUB.Tick()`);
  assert.equal(vm.evaluate(`WoWClaudeDB.forget["${gone}"]`), null, 'forgotten once acked');
  assert.ok(!stripRecords(vm).find(r => r.flags === 'd'), 'forget record left the strip');
});

test('until the bridge answers, Connect replaces Send and a message stays in the box', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWClaude.Toggle(true)');
  assert.equal(vm.evaluate('WoWClaude.IsConnected()'), 'false');
  const texts = () => vm.evaluate('table.concat(STUB.texts, "|")');
  assert.ok(texts().includes('Not connected - start the bridge, then click Connect'));
  // Sending while disconnected puts the text back in the box and starts a connect attempt.
  vm.run('WoWClaudeInput:SetText("fix the bug"); WoWClaude.SendFromInput()');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].pendingId'), null, 'nothing sent');
  assert.equal(vm.evaluate('WoWClaudeInput:GetText()'), 'fix the bug', 'message kept in the box');
  const hello = stripRecords(vm);
  assert.equal(hello.length, 1);
  assert.equal(hello[0].flags, 'h;vol=125', 'a hello went out instead');
  assert.ok(texts().includes('Connecting...'));
  assert.ok(texts().includes('your message goes out as soon as it answers'));
  // No answer within CONNECT_WAIT: the attempt is reported as failed, Connect is back.
  vm.run('STUB.now = STUB.now + 20; STUB.Tick()');
  assert.equal(vm.evaluate('WoWClaude.IsConnected()'), 'false');
  assert.ok(texts().includes('No answer from the bridge'));
  assert.equal(vm.evaluate('WoWClaudeInput:GetText()'), 'fix the bug', 'message still in the box after a failed attempt');
  // Click Connect again; this time the bridge answers the hello poll. Nothing was
  // queued by that click, so the message waits for the user.
  vm.run('WoWClaude.Connect()');
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWClaude.IsConnected()'), 'true');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].pendingId'), null, 'a plain Connect sends nothing by itself');
  vm.run('WoWClaude.SendFromInput()');
  assert.ok(vm.num('WoWClaudeDB.chats[1].pendingId') >= 1, 'the kept message goes out once connected');
  assert.ok(stripRecords(vm).find(r => r.text === 'fix the bug'));
});

test('a message sent while disconnected goes out by itself once the bridge answers', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWClaude.Toggle(true)');
  vm.run('WoWClaudeInput:SetText("fix the bug"); WoWClaude.SendFromInput()');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].pendingId'), null, 'nothing sent yet');
  // The bridge answers the hello poll: the queued message follows without a second click.
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWClaude.IsConnected()'), 'true');
  assert.ok(vm.num('WoWClaudeDB.chats[1].pendingId') >= 1, 'queued message went out on connect');
  assert.ok(stripRecords(vm).find(r => r.text === 'fix the bug'));
  assert.equal(vm.evaluate('WoWClaudeInput:GetText()'), '', 'box cleared after the auto-send');
  // Only once: a later reconnect sends nothing.
  vm.run('WoWClaude.Connect()');
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(stripRecords(vm).filter(r => r.text === 'fix the bug').length, 1);
});

test('without the sound channel, the light stays green between idle slot polls', () => {
  // The stub has no ctl/valid.wav, so the login self-test disables the sound
  // channel: the addon is in "slot checks only" mode, like a client whose
  // PlaySoundFile reports every file as playable.
  const vm = newVM();
  login(vm);
  connect(vm);
  assert.equal(vm.evaluate('WoWClaude.BridgeState()'), 'ok');
  // 90 s of silence used to mean "stale"; with no beats to hear that is normal.
  vm.run('STUB.now = STUB.now + 200; STUB.Tick()');
  assert.equal(vm.evaluate('WoWClaude.BridgeState()'), 'ok', 'still green after 200 s');
  assert.equal(vm.evaluate('WoWClaude.IsConnected()'), 'true');
  // 10 minutes in, the idle poll spends a slot; the bridge's clock in it keeps the light green.
  vm.run('STUB.loadCount = 0; STUB.onLoadAddOn = function(name) STUB.loadCount = STUB.loadCount + 1; WoWClaude_SlotData = { now = time(), cwd = "", replies = {} } end');
  vm.run('STUB.now = STUB.now + 410; STUB.Tick()');
  assert.equal(vm.num('STUB.loadCount'), 1, 'one idle poll');
  assert.equal(vm.evaluate('WoWClaude.BridgeState()'), 'ok', 'green again after the idle poll');
  // A bridge that really is gone still shows: no slot answers, and the light drops.
  vm.run('STUB.onLoadAddOn = function(name) WoWClaude_SlotData = nil end');
  vm.run('STUB.now = STUB.now + 800; STUB.Tick()');
  assert.equal(vm.evaluate('WoWClaude.BridgeState()'), 'stale');
  vm.run('STUB.now = STUB.now + 700; STUB.Tick()');
  assert.equal(vm.evaluate('WoWClaude.BridgeState()'), 'down');
});

test('the Folder... menu item (right-click a chat) opens a prompt that sets the chat folder like /wow-claude cd', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWClaude.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWCLAUDE_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '');
  // Accept the dialog the way the game would: an edit box holding the new path.
  vm.run(`
    local dialog = { editBox = { GetText = function() return "  ..\\\\realms " end } }
    StaticPopupDialogs.WOWCLAUDE_FOLDER.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].cwd'), '..\\realms');
  assert.ok(vm.evaluate('WoWClaudeDB.chats[1].history[#WoWClaudeDB.chats[1].history].text').includes('relative to'));
  vm.run('WoWClaude.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '..\\realms', 'prompt is prefilled with the current folder');
  // A full path gets no "relative to" note; empty goes back to the default.
  vm.run('WoWClaude.SetFolder("C:\\\\other")');
  assert.ok(!vm.evaluate('WoWClaudeDB.chats[1].history[#WoWClaudeDB.chats[1].history].text').includes('relative to'));
  vm.run('WoWClaude.SetFolder("")');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].cwd'), '');
});

test('a sent message is encoded on the strip with the chat folder, then a slot reply finishes it', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.WOWCLAUDE("cd realms")');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].cwd'), 'realms');
  vm.run('WoWClaude.Send("hello world")');
  const chatId = vm.evaluate('WoWClaudeDB.chats[1].id');
  const id = vm.num('WoWClaudeDB.chats[1].pendingId');
  assert.ok(id >= 1);
  const rec = stripRecords(vm).find(r => r.text === 'hello world');
  assert.ok(rec, 'message record on the strip');
  assert.equal(rec.chat, chatId);
  assert.equal(rec.id, id);
  assert.equal(rec.cwd, 'realms');
  assert.equal(rec.flags, '');
  // The chat took its title from the first message.
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].name'), 'Hello world');

  nextSlot(vm, `{ now = time(), cwd = "C:\\\\proj", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "hi back", cwd = "x", session = "s" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // first scheduled poll is 5 s after sending
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].history[#WoWClaudeDB.chats[1].history].role'), 'claude');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].history[#WoWClaudeDB.chats[1].history].text'), 'hi back');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('hi back'), 'reply echoed to the game chat');
  assert.equal(vm.evaluate('WoWClaudeStrip.shown'), 'false', 'strip cleared once nothing is pending');

  // The bridge's default folder arrived with the slot and is what "/wow-claude cd" reports.
  vm.run('SlashCmdList.WOWCLAUDE("cd")');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].cwd'), '');
  assert.ok(vm.evaluate('WoWClaudeDB.chats[1].history[#WoWClaudeDB.chats[1].history].text').includes('C:\\proj'));
});

test('one in-game voice action carries the voice flag, replaces the placeholder transcript and accepts a waypoint', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWClaude.StartVoice()');
  const chatId = vm.evaluate('WoWClaudeDB.chats[1].id');
  const id = vm.num('WoWClaudeDB.chats[1].pendingId');
  const rec = stripRecords(vm).find(r => r.id === id);
  assert.ok(rec.flags.split(';').includes('v'), 'voice request is marked on the strip');
  assert.equal(rec.text, '[Voice] Listening...');

  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "Go to Darkshire.", transcript = "Where should I go?", waypoint = { mapId = 1431, x = 0.452, y = 0.678, label = "Darkshire" } } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].history[1].text'), 'Where should I go?');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].history[2].text'), 'Go to Darkshire.');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].history[2].waypoint.label'), 'Darkshire');
  vm.run('WoWClaude.SetWaypoint(WoWClaudeDB.chats[1].history[2].waypoint)');
  assert.equal(vm.evaluate('STUB.waypoint.mapId'), '1431');
  assert.equal(vm.evaluate('STUB.superTrackedWaypoint'), 'true');
});

test('/wow-claude bind assigns a window-independent Talk hotkey', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.WOWCLAUDE("bind F8")');
  assert.equal(vm.evaluate('STUB.bindings.F8'), 'CLICK WoWVoiceGuideTalkButton:LeftButton');
  assert.equal(vm.evaluate('WoWVoiceGuideTalkButton ~= nil'), 'true');
});

test('voice volume is saved in game and sent to the companion', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  assert.equal(vm.num('WoWClaudeDB.settings.voiceVolume'), 125);
  assert.equal(vm.num('WoWVoiceGuideVolumeSlider:GetValue()'), 125);
  vm.run('SlashCmdList.WOWCLAUDE("volume 165")');
  assert.equal(vm.num('WoWClaudeDB.settings.voiceVolume'), 165);
  assert.equal(vm.num('WoWVoiceGuideVolumeSlider:GetValue()'), 165);
  assert.ok(stripRecords(vm).some(r => r.flags === 'vol=165' && r.text === ''));
});

test('Bindings.xml is left for WoW special-file auto-loading instead of ordinary TOC parsing', () => {
  const addonDir = path.join(__dirname, '..', 'addon', 'WoWClaude');
  const toc = fs.readFileSync(path.join(addonDir, 'WoWClaude.toc'), 'utf8');
  const bindings = fs.readFileSync(path.join(addonDir, 'Bindings.xml'), 'utf8');
  assert.doesNotMatch(toc, /^Bindings\.xml\s*$/m);
  assert.match(bindings, /<Binding\s+name="WOWVOICEGUIDE_TALK"/);
});

test('a denied reply shows Allow, and Allow resends with the rules as flags', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWClaude.Send("search for it")');
  const chatId = vm.evaluate('WoWClaudeDB.chats[1].id');
  const id = vm.num('WoWClaudeDB.chats[1].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "need permission", denied = { "WebSearch", "Bash(cargo:*)" } } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].history[#WoWClaudeDB.chats[1].history].denied[2]'), 'Bash(cargo:*)');
  vm.run(`WoWClaude.Allow("${chatId}", { "WebSearch", "Bash(cargo:*)" })`);
  const rec = stripRecords(vm).find(r => r.flags.includes('allow='));
  assert.ok(rec, 'allow record on the strip');
  assert.equal(rec.flags, 'allow=WebSearch,Bash(cargo:*)');
  assert.equal(rec.id, id + 1);
});

test('/wow-claude reset marks the next message as a new session', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.WOWCLAUDE("reset")');
  vm.run('WoWClaude.Send("start over")');
  const rec = stripRecords(vm).find(r => r.text === 'start over');
  assert.equal(rec.flags, 'n');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].resetNext'), null);
});

test('a restore bundle addressed to this session adds the missing chats once', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWClaude.Send("hi")');
  const chatId = vm.evaluate('WoWClaudeDB.chats[1].id');
  const id = vm.num('WoWClaudeDB.chats[1].pendingId');
  const token = vm.evaluate('WoWClaudeDB.session');
  const bundle = `restore = { token = "${token}", chats = { { id = "old1", name = "Old work", cwd = "C:\\\\old", messages = { { role = "user", id = 1, t = 1, text = "q" }, { role = "claude", id = 1, t = 2, text = "a" } } } } }`;
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "ok" } }, ${bundle} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#WoWClaudeDB.chats'), 2);
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].id'), 'old1');
  assert.equal(vm.num('#WoWClaudeDB.chats[1].history'), 2);
  assert.equal(vm.evaluate('WoWClaudeDB.restored'), 'true');
  // A second bundle with the same token is ignored.
  vm.run('WoWClaude.Send("again")');
  const id2 = vm.num('WoWClaudeDB.chats[2].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id2}, status = "done", text = "ok" } }, ${bundle.replace('old1', 'old2')} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#WoWClaudeDB.chats'), 2);
});

test('chat management commands: new, chat, rename, delete, clear, copy', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.WOWCLAUDE("new Realms")');
  assert.equal(vm.num('#WoWClaudeDB.chats'), 2);
  assert.equal(vm.evaluate('WoWClaudeDB.chats[2].name'), 'Realms');
  assert.equal(vm.evaluate('WoWClaudeDB.activeChat'), vm.evaluate('WoWClaudeDB.chats[2].id'));
  vm.run('SlashCmdList.WOWCLAUDE("chat 1")');
  assert.equal(vm.evaluate('WoWClaudeDB.activeChat'), vm.evaluate('WoWClaudeDB.chats[1].id'));
  vm.run('SlashCmdList.WOWCLAUDE("rename Stuff")');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].name'), 'Stuff');
  vm.run('SlashCmdList.WOWCLAUDE("help")');
  assert.ok(vm.evaluate('WoWClaudeDB.chats[1].history[1].text').includes('/wow-claude cd'));
  vm.run('SlashCmdList.WOWCLAUDE("clear")');
  assert.equal(vm.num('#WoWClaudeDB.chats[1].history'), 0);
  vm.run('SlashCmdList.WOWCLAUDE("delete")');
  assert.equal(vm.num('#WoWClaudeDB.chats'), 1);
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].name'), 'Realms');
  // The copy box builds with a proper backdrop (the stub fails on SetBackdrop(nil)).
  vm.run('WoWClaude.ShowCopy("some reply")');
  assert.equal(vm.evaluate('WoWClaudeCopy.shown'), 'true');
  assert.equal(vm.evaluate('WoWClaudeCopyBox.text'), 'some reply');
});

test('chat rows: right-click opens a menu that renames or sets the folder of that chat, the trash can asks before deleting', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.WOWCLAUDE("new Realms")');
  const first = vm.evaluate('WoWClaudeDB.chats[1].id');
  const second = vm.evaluate('WoWClaudeDB.chats[2].id');
  assert.equal(vm.evaluate('WoWClaudeDB.activeChat'), second);
  // The menu opens for the row's chat, not the active one, and toggles closed on a second open.
  vm.run(`WoWClaude.ShowChatMenu("${first}", WoWClaudeFrame)`);
  assert.equal(vm.evaluate('WoWClaudeChatMenu.shown'), 'true');
  assert.equal(vm.evaluate('WoWClaudeChatMenu.chatId'), first);
  assert.equal(vm.evaluate('WoWClaudeChatMenu.title.text'), 'Chat 1');
  vm.run(`WoWClaude.ShowChatMenu("${first}", WoWClaudeFrame)`);
  assert.equal(vm.evaluate('WoWClaudeChatMenu.shown'), 'false');
  // Rename and Folder prompts target the chat they were opened for.
  vm.run(`WoWClaude.RenamePrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWCLAUDE_RENAME');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  vm.run(`
    local dialog = { editBox = { GetText = function() return "Old stuff" end } }
    StaticPopupDialogs.WOWCLAUDE_RENAME.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].name'), 'Old stuff');
  assert.equal(vm.evaluate('WoWClaudeDB.chats[2].name'), 'Realms');
  vm.run(`WoWClaude.FolderPrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWCLAUDE_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  // The X asks first: nothing happens until OK, then only that chat goes and the active one stays.
  vm.run(`WoWClaude.ConfirmDelete("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWCLAUDE_DELETE');
  assert.equal(vm.num('#WoWClaudeDB.chats'), 2);
  vm.run('StaticPopupDialogs.WOWCLAUDE_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#WoWClaudeDB.chats'), 1);
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].id'), second);
  assert.equal(vm.evaluate('WoWClaudeDB.activeChat'), second);
  // Deleting the last chat clears it instead of removing it.
  vm.run(`WoWClaude.ConfirmDelete("${second}")`);
  vm.run('StaticPopupDialogs.WOWCLAUDE_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#WoWClaudeDB.chats'), 1);
  assert.equal(vm.evaluate('WoWClaudeDB.chats[1].name'), 'Chat 1');
});

test('the window can never be sized past the screen, and size reset restores it', () => {
  const vm = newVM();
  vm.run('UIParent.width, UIParent.height = 1920, 1080; WoWClaudeDB = { settings = { width = 3000, height = 2400, point = "TOPLEFT", x = 5, y = -5 } }');
  login(vm);
  assert.deepEqual([vm.num('WoWClaudeFrame.width'), vm.num('WoWClaudeFrame.height')], [1728, 918], 'a too-large saved size is pulled back on load');
  assert.equal(vm.evaluate('table.concat(WoWClaudeFrame.resizeBounds, ",")'), '560,300,1728,918');
  assert.deepEqual([vm.num('WoWClaudeDB.settings.width'), vm.num('WoWClaudeDB.settings.height')], [1728, 918]);
  vm.run('SlashCmdList.WOWCLAUDE("size reset")');
  assert.deepEqual([vm.num('WoWClaudeFrame.width'), vm.num('WoWClaudeFrame.height')], [780, 500]);
  assert.equal(vm.evaluate('WoWClaudeDB.settings.point'), null, 'position is re-centered');
  assert.equal(vm.evaluate('WoWClaudeFrame.shown'), 'true');
});


test('minimize collapses to the mini bar and back; the mini bar X hides everything', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWClaude.Toggle(true)');
  assert.equal(vm.evaluate('WoWClaudeFrame.shown'), 'true');
  vm.run('WoWClaude.Minimize(true)');
  assert.equal(vm.evaluate('WoWClaudeFrame.shown'), 'false');
  assert.equal(vm.evaluate('WoWClaudeMini.shown'), 'true');
  assert.equal(vm.evaluate('WoWClaudeDB.settings.minimized'), 'true');
  vm.run('WoWClaude.Minimize(false)');
  assert.equal(vm.evaluate('WoWClaudeFrame.shown'), 'true');
  assert.equal(vm.evaluate('WoWClaudeMini.shown'), 'false');
  vm.run('WoWClaude.Toggle(false)');
  assert.equal(vm.evaluate('WoWClaudeFrame.shown'), 'false');
  assert.equal(vm.evaluate('WoWClaudeMini.shown'), 'false');
  assert.equal(vm.evaluate('WoWClaudeDB.settings.shown'), 'false');
});

test('the minimized portrait uses the player image and talks only while audio is signalled', () => {
  const vm = newVM();
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWClaude\\\\ctl\\\\valid.wav"] = true');
  login(vm);
  vm.run('WoWClaude.Minimize(true)');
  assert.equal(vm.evaluate('WoWClaudeMiniPortrait.texture'), 'Interface\\AddOns\\WoWClaude\\portrait-peon');
  assert.equal(vm.num('WoWClaudeMiniPortrait.texCoords[1]'), 0);
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWClaude\\\\ctl\\\\talk.wav"] = true; STUB.now = 1000.2; WoWClaudeMini.scripts.OnUpdate(WoWClaudeMini, 0.4)');
  assert.notEqual(vm.num('WoWClaudeMiniPortrait.texCoords[1]'), 0);
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('speaking'));
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWClaude\\\\ctl\\\\talk.wav"] = nil; WoWClaudeMini.scripts.OnUpdate(WoWClaudeMini, 0.4)');
  assert.equal(vm.num('WoWClaudeMiniPortrait.texCoords[1]'), 0);
});

test('the portrait animates from the reply deadline when the game sound channel is unusable', () => {
  const vm = newVM();
  login(vm); // the stub reproduces a client where the sound-file self-test fails
  connect(vm);
  vm.run('WoWClaude.Minimize(true); WoWClaude.StartVoice()');
  const chatId = vm.evaluate('WoWClaudeDB.chats[1].id');
  const id = vm.num('WoWClaudeDB.chats[1].pendingId');
  nextSlot(vm, `{ now = time(), portrait = "knight", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "A spoken reply", speechEndsAt = time() + 10 } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWClaudeMiniPortrait.texture'), 'Interface\\AddOns\\WoWClaude\\portrait-knight');
  assert.equal(vm.evaluate('WoWClaudeDB.settings.portrait'), 'knight');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('speaking'));
  let moved = false;
  for (let i = 0; i < 7; i++) {
    vm.run('STUB.now = STUB.now + 0.14; WoWClaudeMini.scripts.OnUpdate(WoWClaudeMini, 0.14)');
    if (vm.num('WoWClaudeMiniPortrait.y') !== 0) moved = true;
  }
  assert.equal(moved, true, 'the head bobs as its mouth changes');
  vm.run('STUB.now = STUB.now + 11; WoWClaudeMini.scripts.OnUpdate(WoWClaudeMini, 0.4)');
  assert.equal(vm.num('WoWClaudeMiniPortrait.texCoords[1]'), 0);
  assert.equal(vm.num('WoWClaudeMiniPortrait.y'), 0);
  vm.run('WoWClaude.SetPortrait("guide")');
  assert.equal(vm.evaluate('WoWClaudeMiniPortrait.shown'), 'false');
  assert.equal(vm.evaluate('WoWClaudeMiniMonogram.shown'), 'true');
  vm.run('WoWClaude.SetPortrait("peon")');
  assert.equal(vm.evaluate('WoWClaudeMiniPortrait.texture'), 'Interface\\AddOns\\WoWClaude\\portrait-peon');
});

test('reload mode writes the outbox for the bridge instead of drawing the strip', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.WOWCLAUDE("mode reload")');
  vm.run('SlashCmdList.WOWCLAUDE("reset")');
  vm.run('WoWClaude.Send("via reload")');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true');
  assert.equal(vm.evaluate('WoWClaudeDB.outbox.newSession'), 'true');
  assert.equal(vm.evaluate('WoWClaudeDB.outbox.text'), Buffer.from('via reload').toString('hex'));
  assert.equal(decodeStrip(vm), null);
});

// Announcement records ("a"): their fields, decoded like the bridge does.
function announcements(vm) {
  return stripRecords(vm).filter(r => r.flags === 'a').map(r => Object.fromEntries(r.text.split('\x1C').map(p => p.split('\x1D'))));
}

test('announcement moments go to the companion: quest ready, level up, new zone, bags, durability, accepted quest', () => {
  const vm = newVM();
  vm.run(`STUB.quests = { { questID = 33, title = "Wolves Across the Border", description = "Those wolves are a menace.", instructions = "Bring 8 Tough Wolf Meat." } }`);
  login(vm);
  connect(vm);
  vm.run('STUB.RunTimers(); STUB.Tick()');
  deliverState(vm);
  const fire = ev => { vm.run(ev); vm.run('STUB.RunTimers()'); };
  // The first quest log look only takes note; the next change announces.
  fire('STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(announcements(vm).length, 0);
  fire('STUB.readyQuests[33] = true; STUB.waypointText[33] = "Return to Marshal Dughan"; STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.deepEqual(announcements(vm), [{ kind: 'quest', id: '33', title: 'Wolves Across the Border', next: 'Return to Marshal Dughan' }]);
  deliverState(vm);
  fire('STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(announcements(vm).length, 0, 'announced once');
  fire('STUB.levelSpells = { [24] = { 19552 } }; STUB.FireEvent("PLAYER_LEVEL_UP", 24)');
  assert.deepEqual(announcements(vm)[0], { kind: 'level', level: '24', spells: 'Improved Aspect of the Hawk' });
  deliverState(vm);
  fire('STUB.zone = "Westfall"; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  assert.deepEqual(announcements(vm)[0], { kind: 'zone', zone: 'Westfall', map: '1431' });
  deliverState(vm);
  fire('STUB.freeSlots = 1; STUB.FireEvent("BAG_UPDATE_DELAYED")');
  assert.deepEqual(announcements(vm)[0], { kind: 'bags', free: '1', total: '16' });
  deliverState(vm);
  fire('STUB.FireEvent("BAG_UPDATE_DELAYED")');
  assert.equal(announcements(vm).length, 0, 'not again until the bags were emptied');
  fire('STUB.gear = { [5] = { link = "|Hitem:1|h[Chest]|h", cur = 6, max = 60 } }; STUB.FireEvent("UPDATE_INVENTORY_DURABILITY")');
  assert.deepEqual(announcements(vm)[0], { kind: 'repair', percent: '10', slot: 'Chest' });
  deliverState(vm);
  fire('STUB.FireEvent("QUEST_ACCEPTED", 33)');
  assert.deepEqual(announcements(vm)[0], { kind: 'accept', id: '33', title: 'Wolves Across the Border', text: 'Those wolves are a menace.', objectives: 'Bring 8 Tough Wolf Meat.' });
});

test('announcements wait out combat, respect in-game switches, and follow the companion settings in slot files', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('STUB.RunTimers(); STUB.Tick()');
  deliverState(vm);
  vm.run('STUB.combat = true; STUB.levelSpells = {}; STUB.FireEvent("PLAYER_LEVEL_UP", 24)');
  assert.equal(announcements(vm).length, 0, 'nothing in combat');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(announcements(vm)[0].kind, 'level', 'sent once combat ends');
  deliverState(vm);
  // A moment older than a minute when combat ends is dropped.
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_LEVEL_UP", 25); STUB.now = STUB.now + 90; STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(announcements(vm).length, 0);
  // Switched in game: the companion is told, and this side stops sending.
  vm.run('SlashCmdList.WOWCLAUDE("announce level off")');
  const rec = stripRecords(vm).find(r => r.flags.startsWith('ann='));
  assert.equal(rec.flags, 'ann=level:0');
  assert.match(vm.evaluate('WoWClaudeDB.chats[1].history[#WoWClaudeDB.chats[1].history].text'), /level - level up and new trainer spells: off/);
  deliverState(vm);
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 26)');
  assert.equal(announcements(vm).length, 0);
  vm.run('SlashCmdList.WOWCLAUDE("narrate on")');
  assert.ok(stripRecords(vm).some(r => r.flags === 'ann=narrate:1'));
  vm.run('SlashCmdList.WOWCLAUDE("announce all on")');
  assert.ok(stripRecords(vm).some(r => r.flags === 'ann=quest:1,level:1,zone:1,bags:1,narrate:1'));
  // The companion's settings arrive with the next slot.
  nextSlot(vm, '{ now = time(), cwd = "", replies = {}, announce = { quest = true, level = false, zone = false, bags = false, narrate = false } }');
  vm.run('WoWClaude.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWClaudeDB.settings.announce.level'), 'false');
  assert.equal(vm.evaluate('WoWClaudeDB.settings.announce.quest'), 'true');
});
