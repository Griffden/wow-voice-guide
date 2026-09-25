-- A minimal stand-in for the WoW addon environment, enough to load and drive
-- WoWClaude.lua outside the game (see addon_test.js). Frames are plain tables:
-- capitalized names that aren't listed below resolve to a no-op method, so any
-- SetFoo/EnableBar call is accepted; lowercase names are ordinary fields.
--
-- STUB collects what the addon did: frames, texts, timers, tickers, prints.

STUB = {
	frames = {}, texts = {}, timers = {}, tickers = {}, prints = {}, bindings = {},
	now = 1000, epoch = 1700000000, sounds = {}, loaded = {}, reloaded = false,
	tooltips = {}, zone = "Duskwood", subzone = "Darkshire", level = 23, money = 12345,
	quests = {}, selectedQuest = 0, trackedQuest = 0, questObjectives = {},
	readyQuests = {}, waypointText = {}, completed = { 1, 2, 3, 5, 783, 7, 8 },
}

local function noop() end

local Methods = {}
local FrameMT = {
	__index = function(t, k)
		if type(k) == "string" and k:match("^%u") then
			return Methods[k] or noop
		end
	end,
}

local function NewObject(kind, name, parent)
	local o = setmetatable({ kind = kind, name = name, parent = parent, scripts = {}, hooks = {}, events = {}, shown = true, textures = {}, children = {} }, FrameMT)
	if name then _G[name] = o end
	if parent and type(parent) == "table" and parent.children then table.insert(parent.children, o) end
	return o
end

function Methods.SetScript(self, name, fn) self.scripts[name] = fn end
function Methods.GetScript(self, name) return self.scripts[name] end
function Methods.HookScript(self, name, fn) self.hooks[name] = self.hooks[name] or {}; table.insert(self.hooks[name], fn) end
function Methods.RegisterEvent(self, ev) self.events[ev] = true end
function Methods.UnregisterEvent(self, ev) self.events[ev] = nil end
function Methods.Show(self) self.shown = true end
function Methods.Hide(self)
	local was = self.shown
	self.shown = false
	if was and self.scripts.OnHide then self.scripts.OnHide(self) end
end
function Methods.SetShown(self, v) if v then self:Show() else self:Hide() end end
function Methods.IsShown(self) return self.shown end
function Methods.IsVisible(self) return self.shown end
function Methods.SetText(self, t) self.text = t; table.insert(STUB.texts, tostring(t)) end
function Methods.GetText(self) return self.text or "" end
function Methods.SetValue(self, value)
	self.value = value
	if self.scripts.OnValueChanged then self.scripts.OnValueChanged(self, value) end
end
function Methods.GetValue(self) return self.value or 0 end
function Methods.GetName(self) return self.name end
function Methods.GetParent(self) return self.parent end
function Methods.GetWidth(self) return self.width or 400 end
function Methods.GetHeight(self) return self.height or 300 end
function Methods.SetSize(self, w, h) self.width, self.height = w, h end
function Methods.SetWidth(self, w) self.width = w end
function Methods.SetHeight(self, h) self.height = h end
function Methods.GetSize(self) return self:GetWidth(), self:GetHeight() end
function Methods.SetResizeBounds(self, minW, minH, maxW, maxH) self.resizeBounds = { minW, minH, maxW, maxH } end
function Methods.GetStringHeight(self) return 14 end
function Methods.GetStringWidth(self) return 100 end
function Methods.GetFontString(self) return self end
function Methods.GetPoint(self) return "CENTER", nil, "CENTER", 0, 0 end
function Methods.SetPoint(self, point, rel, relPoint, x, y)
	if type(rel) == "number" then x, y = rel, relPoint end
	self.x, self.y = x or 0, y or 0
end
function Methods.GetVerticalScrollRange(self) return 0 end
function Methods.CreateTexture(self, name, layer)
	local t = NewObject("Texture", name, self)
	table.insert(self.textures, t)
	return t
end
function Methods.CreateFontString(self, name) return NewObject("FontString", name, self) end
function Methods.CreateAnimationGroup(self) return NewObject("AnimationGroup", nil, self) end
function Methods.CreateAnimation(self) return NewObject("Animation", nil, self) end
function Methods.IsPlaying(self) return self.playing or false end
function Methods.Play(self) self.playing = true end
function Methods.Stop(self) self.playing = false end
function Methods.SetColorTexture(self, r, g, b, a) self.color = { r, g, b, a } end
function Methods.SetTexture(self, path) self.texture = path; return true end
function Methods.SetTexCoord(self, ...) self.texCoords = { ... } end
function Methods.GetTexture(self) return self.texture end
function Methods.SetBackdrop(self, t)
	-- The real client would silently draw nothing; make it a test failure instead.
	assert(type(t) == "table", "SetBackdrop called with " .. tostring(t) .. " on " .. tostring(self.name or self.kind))
	self.backdrop = t
end
function Methods.SetFocus(self) STUB.focus = self end
function Methods.ClearFocus(self) if STUB.focus == self then STUB.focus = nil end end
function Methods.HasFocus(self) return STUB.focus == self end
function Methods.Insert(self, t) self.text = (self.text or "") .. tostring(t) end
function Methods.GetEditBox(self) return self.editBox end
-- Tooltip scanning: SetHyperlink fills <name>TextLeft<i> / TextRight<i> from
-- STUB.tooltips[link], a list of strings or { left, right } pairs.
function Methods.ClearLines(self) self.lines = {} end
function Methods.NumLines(self) return #(self.lines or {}) end
function Methods.SetHyperlink(self, link)
	self.lines = STUB.tooltips[link] or {}
	for i, l in ipairs(self.lines) do
		local left, right = l, nil
		if type(l) == "table" then left, right = l[1], l[2] end
		local L = NewObject("FontString", self.name .. "TextLeft" .. i, self)
		L.text = left
		local R = NewObject("FontString", self.name .. "TextRight" .. i, self)
		R.text = right
		R.shown = right ~= nil
	end
end

function CreateFrame(kind, name, parent, template)
	local f = NewObject(kind, name, parent)
	f.template = template
	table.insert(STUB.frames, f)
	return f
end

-- Fire an event on every frame that registered for it.
function STUB.FireEvent(ev, ...)
	for _, f in ipairs(STUB.frames) do
		if f.events[ev] and f.scripts.OnEvent then f.scripts.OnEvent(f, ev, ...) end
	end
end

-- Run every C_Timer.After callback that is due, then every ticker once.
function STUB.RunTimers()
	local due = STUB.timers
	STUB.timers = {}
	for _, t in ipairs(due) do t.fn() end
end
function STUB.Tick()
	for _, fn in ipairs(STUB.tickers) do fn() end
end

UIParent = CreateFrame("Frame", "UIParent")
GameTooltip = CreateFrame("Frame", "GameTooltip")
UIErrorsFrame = CreateFrame("Frame", "UIErrorsFrame")
ChatFontNormal = {}
OKAY, CANCEL = "Okay", "Cancel"
NUM_CHAT_WINDOWS = 1
StaticPopupDialogs = {}
function StaticPopup_Show(which, a, b, data) STUB.popup = { which = which, data = data } end
SlashCmdList = {}
UISpecialFrames = {}
tinsert = table.insert
function wipe(t) for k in pairs(t) do t[k] = nil end return t end
function hooksecurefunc(a, b, c)
	if type(a) == "table" then
		local orig = a[b]
		a[b] = function(...) local r = orig(...); c(...); return r end
	else
		local orig = _G[a]
		_G[a] = function(...) local r = orig(...); b(...); return r end
	end
end
function InCombatLockdown() return STUB.combat or false end
function UnitAffectingCombat(unit) return STUB.combat or false end
function ReloadUI() STUB.reloaded = true end
function GetTime() return STUB.now end
function time() return STUB.epoch + math.floor(STUB.now) end
function date(fmt, t) return "12:00" end
C_Timer = {
	After = function(delay, fn) table.insert(STUB.timers, { delay = delay, fn = fn }) end,
	NewTicker = function(delay, fn) table.insert(STUB.tickers, fn); return { Cancel = noop } end,
}
C_AddOns = {
	IsAddOnLoaded = function(name) return STUB.loaded[name] or false end,
	LoadAddOn = function(name)
		STUB.loaded[name] = true
		if STUB.onLoadAddOn then STUB.onLoadAddOn(name) end
		return true
	end,
}
C_Texture = { GetAtlasExists = function() return true end }
function PlaySound() end
function PlaySoundFile(path) if STUB.sounds[path] then return true, 1 end return false end
function StopSound() end
function GetPhysicalScreenSize() return 1920, 1080 end
function SetBinding(key, cmd) STUB.bindings[key] = cmd end
function SaveBindings() end
function GetCurrentBindingSet() return 1 end
function SetItemRef() end
-- Nothing of Blizzard's is ever active here, so the link goes nowhere unless the
-- addon takes it. The Forever client's UI code calls ChatFrameUtil.InsertLink;
-- ChatEdit_InsertLink is the older global name.
ChatFrameUtil = { InsertLink = function(text) return false end }
function ChatEdit_InsertLink(text) return ChatFrameUtil.InsertLink(text) end

-- The character, for the game context (WoWClaude.GameContext).
function GetBuildInfo() return "1.60.1", "69913", "Sep 1 2026", 16001 end
function UnitName(unit)
	if unit == "player" then return "Testchar" end
	if unit == "target" and STUB.target then return STUB.target.name end
	if unit == "npc" then return STUB.npcName end
end
function GetRealmName() return "Test Realm" end
function UnitLevel(unit)
	if unit == "target" then return STUB.target and STUB.target.level end
	return STUB.level
end
function UnitRace(unit) return "Night Elf", "NightElf" end
function UnitClass(unit) return "Hunter", "HUNTER" end
function UnitFactionGroup(unit) return "Alliance", "Alliance" end
function GetGuildInfo(unit) return "Test Guild", "Member", 1 end
function GetZoneText() return STUB.zone end
function GetSubZoneText() return STUB.subzone end
function GetMoney() return STUB.money end
C_Map = {
	GetBestMapForUnit = function(unit) return 1431 end,
	GetPlayerMapPosition = function(mapId, unit) return { x = STUB.posX or 0.452, y = STUB.posY or 0.678 } end,
	GetMapInfo = function(mapId) return { name = "Duskwood", mapID = mapId } end,
	SetUserWaypoint = function(point) STUB.waypoint = point end,
}
UiMapPoint = {
	CreateFromCoordinates = function(mapId, x, y) return { mapId = mapId, x = x, y = y } end,
}
C_SuperTrack = {
	GetSuperTrackedQuestID = function() return STUB.trackedQuest end,
	SetSuperTrackedUserWaypoint = function(value) STUB.superTrackedWaypoint = value end,
}
C_QuestLog = {
	GetNumQuestLogEntries = function() return #STUB.quests end,
	GetInfo = function(index) return STUB.quests[index] end,
	GetSelectedQuest = function() return STUB.selectedQuest end,
	GetTitleForQuestID = function(id)
		for _, quest in ipairs(STUB.quests) do if quest.questID == id then return quest.title end end
	end,
	GetQuestObjectives = function(id) return STUB.questObjectives[id] end,
	ReadyForTurnIn = function(id) return STUB.readyQuests[id] or false end,
	IsComplete = function(id) return STUB.readyQuests[id] or false end,
	GetNextWaypointText = function(id) return STUB.waypointText[id] end,
	GetAllCompletedQuestIDs = function() return STUB.completed end,
	GetLogIndexForQuestID = function(id)
		for i, quest in ipairs(STUB.quests) do if quest.questID == id then return i end end
	end,
}
function GetQuestLogCompletionText(index)
	local quest = STUB.quests[index] or {}
	return quest.completion
end
function GetQuestLogQuestText(index)
	local quest = STUB.quests[index] or {}
	return quest.description, quest.instructions
end
function UnitXP(unit) return 1234 end
function UnitXPMax(unit) return 5000 end
function GetXPExhaustion() return STUB.rested end
function IsResting() return STUB.resting end
function GetBindLocation() return "Darkshire" end
function IsInInstance() return false, "none" end
-- The Forever client has the modern talent API only (no GetNumTalentTabs).
C_SpecializationInfo = {
	GetSpecialization = function() return 1 end,
	GetSpecializationInfo = function(i) return 253, "Beast Mastery" end,
}
C_ClassTalents = { GetActiveConfigID = function() return 7 end }
local TRAIT_NODES = {
	[101] = { rank = 3, entry = 1001, def = 5001, spell = 19552, name = "Improved Aspect of the Hawk" },
	[102] = { rank = 0, entry = 1002, def = 5002, spell = 19553, name = "Endurance Training" },
	[103] = { rank = 1, entry = 1003, def = 5003, spell = 19554, name = "Bestial Swiftness" },
}
C_Traits = {
	GetConfigInfo = function(id) return { ID = id, treeIDs = { 9 } } end,
	GetTreeNodes = function(tree) return { 101, 102, 103 } end,
	GetNodeInfo = function(config, node)
		local n = TRAIT_NODES[node]
		return { ID = node, ranksPurchased = n.rank, activeRank = n.rank, activeEntry = { entryID = n.entry } }
	end,
	GetEntryInfo = function(config, entry)
		for _, n in pairs(TRAIT_NODES) do if n.entry == entry then return { definitionID = n.def } end end
	end,
	GetDefinitionInfo = function(def)
		for _, n in pairs(TRAIT_NODES) do if n.def == def then return { spellID = n.spell } end end
	end,
}
C_SpellBook = {
	GetCurrentLevelSpells = function(level) return STUB.levelSpells and STUB.levelSpells[level] end,
}
C_Spell = {
	GetSpellName = function(id)
		for _, n in pairs(TRAIT_NODES) do if n.spell == id then return n.name end end
		return STUB.spellNames and STUB.spellNames[id]
	end,
}
TRADE_SKILLS, SECONDARY_SKILLS = "Professions", "Secondary Skills"
local SKILLS = {
	{ "Class Skills", true }, { "Bows", false, 46, 115 },
	{ "Professions", true }, { "Skinning", false, 75, 75 },
	{ "Secondary Skills", true }, { "First Aid", false, 40, 75 },
	{ "Weapon Skills", true }, { "Swords", false, 10, 115 },
}
-- Skill lines through C_SkillInfo (the globals are gone on Forever); answers with a table.
C_SkillInfo = {
	GetNumSkillLines = function() return #SKILLS end,
	GetSkillLineInfo = function(i)
		local s = SKILLS[i]
		return { skillLineName = s[1], isHeader = s[2] or false, skillLineRank = s[3], skillLineMaxRank = s[4] }
	end,
}
-- Target, NPC dialogs, flight map, gear: driven by fields on STUB.
function UnitExists(unit) return unit == "target" and STUB.target ~= nil end
function UnitClassification(unit) return STUB.target and STUB.target.classification end
function UnitCreatureType(unit) return STUB.target and STUB.target.creatureType end
function UnitReaction(unit, other) return STUB.target and STUB.target.reaction end
function UnitIsPlayer(unit) return unit == "player" or (unit == "target" and STUB.target and STUB.target.player) or false end
function UnitGUID(unit) return STUB.target and STUB.target.guid end
function UnitHealth() STUB.healthRead = true; error("the add-on must never read health") end
C_GossipInfo = {
	GetText = function() return STUB.gossip and STUB.gossip.text end,
	GetAvailableQuests = function() return STUB.gossip and STUB.gossip.available or {} end,
	GetActiveQuests = function() return STUB.gossip and STUB.gossip.active or {} end,
	GetOptions = function() return STUB.gossip and STUB.gossip.options or {} end,
}
function GetTitleText() return STUB.questDialog and STUB.questDialog.title end
function GetQuestText() return STUB.questDialog and STUB.questDialog.text end
function GetObjectiveText() return STUB.questDialog and STUB.questDialog.objective end
function GetQuestID() return STUB.questDialog and STUB.questDialog.id or 0 end
function GetTaxiMapID() return 1414 end
C_TaxiMap = {
	GetAllTaxiNodes = function(mapId) return STUB.taxiNodes or {} end,
}
Enum = { FlightPathState = { Current = 0, Reachable = 1, Unreachable = 2 } }
function GetInventoryItemLink(unit, slot) return STUB.gear and STUB.gear[slot] and STUB.gear[slot].link end
function GetInventoryItemDurability(slot)
	local g = STUB.gear and STUB.gear[slot]
	if g and g.max then return g.cur, g.max end
end
function GetAverageItemLevel() return STUB.avgIlvl end
C_Container = {
	GetContainerNumSlots = function(bag) return bag == 0 and 16 or (STUB.bagSlots or 0) end,
	GetContainerNumFreeSlots = function(bag) return bag == 0 and (STUB.freeSlots or 10) or 0, 0 end,
}
ITEM_QUALITY2_DESC = "Uncommon"
C_Item = {
	GetDetailedItemLevelInfo = function(link) return STUB.ilvl and STUB.ilvl[link] end,
	GetItemInfo = function(link)
		if tostring(link):find("^item:2140") then return "Fine Longsword", link, 2, 19, 14, "Weapon", "One-Handed Swords" end
	end,
}
function print(...)
	local parts = {}
	for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
	table.insert(STUB.prints, table.concat(parts, " "))
end
