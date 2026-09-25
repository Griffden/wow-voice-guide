-- WoW Voice Guide game state: what the guide knows about the character, as
-- small named sections of text.
--
-- The companion never asks the game anything mid-answer (replies travel back
-- through load-on-demand slots, which is slow), so the add-on pushes what
-- changed as it changes: WoWClaude.lua marks a section dirty on the game event
-- that affects it, rebuilds it a moment later with the builders below, and
-- sends only sections whose text changed. The bridge keeps the latest copy of
-- every section and assembles the model's context from them per question.
--
-- Sections (key: what it holds, what refreshes it):
--   char     game, client, character, hearthstone      login, level up, bind
--   prog     money, XP, rested XP                      XP/money/rest events (slow)
--   loc      zone, subzone, map position               zone changes, movement
--   quest    the focused quest in full                 quest log/tracking updates
--   quests   every quest in the log, compact           quest log updates
--   npc      the NPC dialog last opened                gossip and quest dialogs
--   target   the current target (never its health)     target changes
--   talents  spec and spent talents (C_Traits)         talent changes
--   prof     professions and skill ranks               skill changes
--   taxi     known flight paths                        opening a flight map
--   gear     equipped items, durability, bag space     equipment/bag changes
--   done.N   completed quest ids, compressed           once per session, then
--   done.new quests turned in since then               QUEST_TURNED_IN
--
-- Every API here is optional and called through Try: a function the Forever
-- client lacks, or one that errors, just leaves its line out. Nothing reads
-- health, auras, cooldowns or the combat log (secret values in combat).

WoWClaude_State = {}
local S = WoWClaude_State

-- Call a game API that may not exist or may throw, and get its returns or nothing.
local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d, e, f, g, h, i, j = pcall(fn, ...)
	if ok then return a, b, c, d, e, f, g, h, i, j end
end
S.Try = Try

-- One line of text: no control characters (they are the strip's separators),
-- single spaces, and cut to `max` bytes without splitting a UTF-8 character.
local function Clean(s, max)
	s = tostring(s or ""):gsub("[%c]", " "):gsub("%s+", " "):gsub("^ ", ""):gsub(" $", "")
	if max and #s > max then
		local cut = max - 3
		while cut > 0 and s:byte(cut + 1) and s:byte(cut + 1) >= 0x80 and s:byte(cut + 1) < 0xC0 do cut = cut - 1 end
		s = s:sub(1, cut) .. "..."
	end
	return s
end
S.Clean = Clean

-- Keep whole lines up to `max` bytes.
local function Fit(lines, max)
	local kept, used = {}, 0
	for _, line in ipairs(lines) do
		local cost = #line + (#kept > 0 and 1 or 0)
		if used + cost > max then break end
		table.insert(kept, line)
		used = used + cost
	end
	return table.concat(kept, "\n")
end
S.Fit = Fit

-- Per-section byte budgets. The strip carries ~3.2 KB per frame for everything,
-- so a section never needs more than one state record.
S.BUDGET = {
	char = 400, prog = 200, loc = 250, quest = 1100, quests = 1200, npc = 1000,
	target = 200, talents = 600, prof = 250, taxi = 800, gear = 900,
}
S.ORDER = { "char", "prog", "loc", "target", "npc", "quest", "quests", "talents", "prof", "gear", "taxi" }

local function Money(copper)
	copper = tonumber(copper) or 0
	local g, s, c = math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100
	if g > 0 then return g .. "g " .. s .. "s " .. c .. "c" end
	if s > 0 then return s .. "s " .. c .. "c" end
	return c .. "c"
end
S.Money = Money

---------------------------------------------------------------------------
-- Character, progress, location
---------------------------------------------------------------------------

function S.Char()
	local lines = {}
	local version, build, _, toc = Try(GetBuildInfo)
	toc = tonumber(toc)
	local game = "World of Warcraft"
	if toc and toc >= 16000 and toc < 20000 then game = "World of Warcraft: Forever" end
	local client = ""
	if version then
		client = " (client " .. tostring(version) .. (build and ("." .. tostring(build)) or "") .. (toc and (", interface " .. toc) or "") .. ")"
	end
	table.insert(lines, "Game: " .. game .. client)
	local name = Try(UnitName, "player")
	if name then
		local realm = Try(GetRealmName)
		local level = Try(UnitLevel, "player")
		local race = Try(UnitRace, "player")
		local class = Try(UnitClass, "player")
		local faction = Try(UnitFactionGroup, "player")
		local guild = Try(GetGuildInfo, "player")
		local who = "Character: " .. tostring(name) .. (realm and (" on " .. tostring(realm)) or "")
		local desc = {}
		if level then table.insert(desc, "level " .. tostring(level)) end
		if race then table.insert(desc, tostring(race)) end
		if class then table.insert(desc, tostring(class)) end
		if #desc > 0 then who = who .. ", " .. table.concat(desc, " ") end
		if faction then who = who .. " (" .. tostring(faction) .. ")" end
		if guild then who = who .. ", guild <" .. tostring(guild) .. ">" end
		table.insert(lines, Clean(who, 200))
	end
	local bind = Try(GetBindLocation)
	if type(bind) == "string" and bind ~= "" then table.insert(lines, "Hearthstone: " .. Clean(bind, 80)) end
	return Fit(lines, S.BUDGET.char)
end

function S.Progress()
	local parts = {}
	local copper = Try(GetMoney)
	if copper then table.insert(parts, "Money: " .. Money(copper)) end
	local xp, xpMax = Try(UnitXP, "player"), Try(UnitXPMax, "player")
	if type(xp) == "number" and type(xpMax) == "number" and xpMax > 0 then
		table.insert(parts, "XP: " .. xp .. "/" .. xpMax)
	end
	local rested = Try(GetXPExhaustion)
	if type(rested) == "number" and rested > 0 then table.insert(parts, "Rested XP: " .. rested) end
	if Try(IsResting) then table.insert(parts, "resting") end
	return Fit({ table.concat(parts, "; ") }, S.BUDGET.prog)
end

-- Zone text plus the player's map position, as the minimap shows it (0-100
-- across the current map; addons get no world x/y/z). Also returns the raw
-- numbers so the caller can tell how far the player moved.
function S.Location()
	local lines = {}
	local zone = Try(GetZoneText)
	local sub = Try(GetSubZoneText)
	if zone and zone ~= "" then
		table.insert(lines, Clean("Location: " .. zone .. ((sub and sub ~= "" and sub ~= zone) and (" - " .. sub) or ""), 150))
	end
	local x, y, mapName
	local mapId = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	if type(mapId) == "number" then
		local pos = Try(C_Map.GetPlayerMapPosition, mapId, "player")
		if type(pos) == "table" and type(pos.x) == "number" and type(pos.y) == "number" then x, y = pos.x, pos.y end
		local info = Try(C_Map.GetMapInfo, mapId)
		if type(info) == "table" and type(info.name) == "string" then mapName = info.name end
	end
	if not x then
		local px, py = Try(GetPlayerMapPosition, "player")
		if type(px) == "number" and type(py) == "number" then x, y = px, py end
	end
	if x and y and (x > 0 or y > 0) then
		local where = (mapName and mapName ~= zone) and (" on " .. mapName) or ""
		table.insert(lines, string.format("Position: %.1f, %.1f%s%s", x * 100, y * 100, where, mapId and (" (map " .. mapId .. ")") or ""))
	else
		x, y = nil, nil
	end
	local inInstance, kind = Try(IsInInstance)
	if inInstance then
		local iname = Try(GetInstanceInfo)
		if type(iname) == "string" and iname ~= "" then table.insert(lines, Clean("Instance: " .. iname .. (kind and (" (" .. tostring(kind) .. ")") or ""), 100)) end
	end
	return Fit(lines, S.BUDGET.loc), mapId, x, y
end

---------------------------------------------------------------------------
-- Quests
---------------------------------------------------------------------------

-- The visible quests in the log: { id, title, index, ready, failed, complete }.
function S.QuestList()
	local quests = {}
	local entries = Try(C_QuestLog and C_QuestLog.GetNumQuestLogEntries)
	if type(entries) ~= "number" then return quests end
	for i = 1, math.min(entries, 100) do
		local info = Try(C_QuestLog.GetInfo, i)
		if type(info) == "table" and not info.isHeader and not info.isHidden
			and type(info.questID) == "number" and info.questID > 0 then
			local q = { id = info.questID, title = (Clean(info.title or "Unknown", 70):gsub(";", ",")), index = i }
			q.ready = Try(C_QuestLog.ReadyForTurnIn, q.id) and true or false
			q.failed = info.isComplete == -1
			q.complete = q.ready or info.isComplete == 1 or info.isComplete == true or (Try(C_QuestLog.IsComplete, q.id) and true or false)
			table.insert(quests, q)
		end
	end
	return quests
end

-- The quest a "where do I go?" is about: the one selected in the log, else the
-- one tracked on the HUD, else the only one.
function S.FocusedQuest(quests)
	local selectedId = Try(C_QuestLog and C_QuestLog.GetSelectedQuest)
	local trackedId = Try(C_SuperTrack and C_SuperTrack.GetSuperTrackedQuestID)
	if type(selectedId) == "number" and selectedId > 0 then return selectedId, "Selected" end
	if type(trackedId) == "number" and trackedId > 0 then return trackedId, "Tracked" end
	if #quests == 1 then return quests[1].id, "Only" end
end

local function Objectives(id)
	local out = {}
	local objectives = Try(C_QuestLog and C_QuestLog.GetQuestObjectives, id)
	if type(objectives) == "table" then
		for i = 1, math.min(#objectives, 6) do
			local o = objectives[i]
			if type(o) == "table" and type(o.text) == "string" and o.text ~= "" then
				table.insert(out, { text = Clean(o.text, 110), finished = o.finished and true or false })
			end
		end
	end
	return out
end
S.Objectives = Objectives

-- Title, status, objectives, next step and the full text of one quest in the log.
function S.QuestDetail(quest, focusKind)
	local lines = { (focusKind or "Quest") .. " quest: " .. quest.title .. " (id " .. quest.id .. ")" }
	if quest.ready then table.insert(lines, "Status: objectives complete, ready to turn in")
	elseif quest.failed then table.insert(lines, "Status: failed")
	elseif quest.complete then table.insert(lines, "Status: complete")
	end
	for _, o in ipairs(Objectives(quest.id)) do
		table.insert(lines, "Objective: " .. o.text .. (o.finished and " (complete)" or ""))
	end
	local step = Try(C_QuestLog and C_QuestLog.GetNextWaypointText, quest.id)
	if type(step) == "string" and step ~= "" then table.insert(lines, "Next step: " .. Clean(step, 160)) end
	if quest.index then
		local description, instructions = Try(GetQuestLogQuestText, quest.index)
		if type(instructions) == "string" and instructions ~= "" then
			table.insert(lines, "Quest instructions: " .. Clean(instructions, 300))
		end
		if quest.ready then
			local done = Try(GetQuestLogCompletionText, quest.index)
			if type(done) == "string" and done ~= "" then table.insert(lines, "Turn-in text: " .. Clean(done, 250)) end
		end
		if type(description) == "string" and description ~= "" then
			table.insert(lines, "Quest description: " .. Clean(description, 600))
		end
	end
	return lines
end

-- Returns the "quest" and "quests" sections. The formats ("Selected quest: T (id N)",
-- "Quest log (N): T (#N); ...") are what bridge/wowdata.js parses.
function S.Quests()
	local quests = S.QuestList()
	local byId = {}
	for _, q in ipairs(quests) do byId[q.id] = q end
	local focusId, focusKind = S.FocusedQuest(quests)
	local focus = ""
	if focusId then
		local q = byId[focusId] or { id = focusId, title = Clean(Try(C_QuestLog and C_QuestLog.GetTitleForQuestID, focusId) or "Unknown", 70) }
		focus = Fit(S.QuestDetail(q, focusKind), S.BUDGET.quest)
	end
	local log = ""
	if #quests > 0 then
		local prefix = "Quest log (" .. #quests .. "): "
		local names, room = {}, S.BUDGET.quests - #prefix
		for _, q in ipairs(quests) do
			local state
			if q.ready then state = "ready to turn in"
			elseif q.failed then state = "failed"
			else
				local parts = {}
				for _, o in ipairs(Objectives(q.id)) do
					if not o.finished then table.insert(parts, (Clean(o.text, 40):gsub(";", ","))) end
					if #parts >= 2 then break end
				end
				state = #parts > 0 and table.concat(parts, ", ") or nil
			end
			local entry = q.title .. " (#" .. q.id .. ")" .. (state and (" [" .. state .. "]") or "")
			local cost = #entry + (#names > 0 and 2 or 0)
			if cost > room then break end
			table.insert(names, entry)
			room = room - cost
		end
		log = prefix .. table.concat(names, "; ")
	end
	return focus, log, quests
end

---------------------------------------------------------------------------
-- Completed quests: sorted ids as runs, base 36, deltas from the previous
-- run's end. "a~3" is 4 ids starting 10 after the previous one. Each chunk
-- starts from 0, so chunks decode on their own (bridge/gamestate.js).
---------------------------------------------------------------------------

local DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"
local function Base36(n)
	n = math.floor(n)
	if n == 0 then return "0" end
	local s = ""
	while n > 0 do
		local d = n % 36
		s = DIGITS:sub(d + 1, d + 1) .. s
		n = math.floor(n / 36)
	end
	return s
end
S.Base36 = Base36

-- ids: any list of numbers. Returns a list of chunks, each at most `max` bytes.
function S.EncodeIds(ids, max)
	max = max or 1200
	local sorted, seen = {}, {}
	for _, id in pairs(ids or {}) do
		id = tonumber(id)
		if id and id > 0 and not seen[id] then seen[id] = true; table.insert(sorted, math.floor(id)) end
	end
	table.sort(sorted)
	local runs = {}
	for _, id in ipairs(sorted) do
		local last = runs[#runs]
		if last and id == last.start + last.len then last.len = last.len + 1
		else table.insert(runs, { start = id, len = 1 }) end
	end
	local chunks, tokens, size, prev = {}, {}, 0, 0
	for _, r in ipairs(runs) do
		local tok = Base36(r.start - prev) .. (r.len > 1 and ("~" .. Base36(r.len - 1)) or "")
		if size + #tok + 1 > max and #tokens > 0 then
			table.insert(chunks, table.concat(tokens, ","))
			tokens, size, prev = {}, 0, 0
			tok = Base36(r.start) .. (r.len > 1 and ("~" .. Base36(r.len - 1)) or "")
		end
		table.insert(tokens, tok)
		size = size + #tok + 1
		prev = r.start + r.len - 1
	end
	if #tokens > 0 then table.insert(chunks, table.concat(tokens, ",")) end
	return chunks, #sorted
end

function S.CompletedIds()
	local ids = Try(C_QuestLog and C_QuestLog.GetAllCompletedQuestIDs)
	if type(ids) ~= "table" then return nil end
	return ids
end

---------------------------------------------------------------------------
-- NPC dialog: captured while the frame is open (the API only answers then)
---------------------------------------------------------------------------

local function QuestRefs(list, withState)
	local out = {}
	for _, q in ipairs(list or {}) do
		if type(q) == "table" and q.title then
			local s = Clean(q.title, 60) .. (type(q.questID) == "number" and (" (#" .. q.questID .. ")") or "")
			if withState and q.isComplete then s = s .. " [complete]" end
			table.insert(out, s)
		end
	end
	return out
end

-- event: the GOSSIP_SHOW / QUEST_* event that opened the dialog.
function S.Dialog(event)
	local lines = {}
	local npc = Try(UnitName, "npc")
	if npc then table.insert(lines, "Talking to: " .. Clean(npc, 60)) end
	if event == "GOSSIP_SHOW" then
		local said = Try(C_GossipInfo and C_GossipInfo.GetText)
		if type(said) == "string" and said ~= "" then table.insert(lines, "Says: " .. Clean(said, 450)) end
		local available = QuestRefs(Try(C_GossipInfo and C_GossipInfo.GetAvailableQuests))
		if #available > 0 then table.insert(lines, "Offers quests: " .. table.concat(available, "; ")) end
		local active = QuestRefs(Try(C_GossipInfo and C_GossipInfo.GetActiveQuests), true)
		if #active > 0 then table.insert(lines, "Your quests with this NPC: " .. table.concat(active, "; ")) end
		local options = {}
		for _, o in ipairs(Try(C_GossipInfo and C_GossipInfo.GetOptions) or {}) do
			if type(o) == "table" and type(o.name) == "string" and o.name ~= "" then table.insert(options, Clean(o.name, 60)) end
			if #options >= 6 then break end
		end
		if #options > 0 then table.insert(lines, "Dialog options: " .. table.concat(options, " | ")) end
	elseif event == "QUEST_GREETING" then
		local said = Try(GetGreetingText)
		if type(said) == "string" and said ~= "" then table.insert(lines, "Says: " .. Clean(said, 450)) end
		local available, active = {}, {}
		for i = 1, math.min(Try(GetNumAvailableQuests) or 0, 10) do
			local title = Try(GetAvailableTitle, i)
			local _, _, _, _, id = Try(GetAvailableQuestInfo, i)
			if title then table.insert(available, Clean(title, 60) .. (type(id) == "number" and (" (#" .. id .. ")") or "")) end
		end
		for i = 1, math.min(Try(GetNumActiveQuests) or 0, 10) do
			local title = Try(GetActiveTitle, i)
			local id = Try(GetActiveQuestID, i)
			if title then table.insert(active, Clean(title, 60) .. (type(id) == "number" and (" (#" .. id .. ")") or "")) end
		end
		if #available > 0 then table.insert(lines, "Offers quests: " .. table.concat(available, "; ")) end
		if #active > 0 then table.insert(lines, "Your quests with this NPC: " .. table.concat(active, "; ")) end
	else
		local title = Try(GetTitleText)
		local id = Try(GetQuestID)
		local ref = Clean(title or "a quest", 70) .. ((type(id) == "number" and id > 0) and (" (#" .. id .. ")") or "")
		if event == "QUEST_DETAIL" then
			table.insert(lines, "Offers quest: " .. ref)
			local text = Try(GetQuestText)
			if type(text) == "string" and text ~= "" then table.insert(lines, "Quest text: " .. Clean(text, 550)) end
			local objective = Try(GetObjectiveText)
			if type(objective) == "string" and objective ~= "" then table.insert(lines, "Objectives: " .. Clean(objective, 250)) end
		elseif event == "QUEST_PROGRESS" then
			table.insert(lines, "Turning in: " .. ref)
			local text = Try(GetProgressText)
			if type(text) == "string" and text ~= "" then table.insert(lines, "Says: " .. Clean(text, 400)) end
		elseif event == "QUEST_COMPLETE" then
			table.insert(lines, "Completing: " .. ref)
			local text = Try(GetRewardText)
			if type(text) == "string" and text ~= "" then table.insert(lines, "Says: " .. Clean(text, 400)) end
		end
	end
	if #lines == 0 then return "" end
	return Fit(lines, S.BUDGET.npc)
end

---------------------------------------------------------------------------
-- Target: who it is, never its health (a secret value in combat)
---------------------------------------------------------------------------

local CLASSIFICATION = { elite = "elite", rare = "rare", rareelite = "rare elite", worldboss = "boss", trivial = "trivial", minus = "minor" }

function S.Target()
	if not Try(UnitExists, "target") then return "" end
	local name = Try(UnitName, "target")
	if not name then return "" end
	local parts = {}
	local level = Try(UnitLevel, "target")
	if type(level) == "number" then table.insert(parts, level < 0 and "level ??" or ("level " .. level)) end
	local class = CLASSIFICATION[Try(UnitClassification, "target") or ""]
	if class then table.insert(parts, class) end
	if Try(UnitIsPlayer, "target") then
		local race = Try(UnitRace, "target")
		local cls = Try(UnitClass, "target")
		table.insert(parts, "player" .. (race and (" " .. race) or "") .. (cls and (" " .. cls) or ""))
	else
		local ctype = Try(UnitCreatureType, "target")
		if type(ctype) == "string" and ctype ~= "" then table.insert(parts, ctype) end
	end
	local line = "Target: " .. Clean(name, 60) .. (#parts > 0 and (", " .. table.concat(parts, " ")) or "")
	local reaction = Try(UnitReaction, "target", "player")
	if type(reaction) == "number" then
		line = line .. ", " .. (reaction <= 3 and "hostile" or reaction == 4 and "neutral" or "friendly")
	end
	-- The NPC id from the GUID (Creature-0-server-instance-zone-npcId-spawn)
	-- lets the guide look the creature up.
	local guid = Try(UnitGUID, "target")
	local ok, npcId = pcall(function() return guid and tostring(guid):match("^%a+%-%d+%-%d+%-%d+%-%d+%-(%d+)%-") end)
	if ok and npcId and not Try(UnitIsPlayer, "target") then line = line .. " (npc " .. npcId .. ")" end
	return Fit({ Clean(line, S.BUDGET.target) }, S.BUDGET.target)
end

---------------------------------------------------------------------------
-- Talents (C_ClassTalents / C_Traits on the Forever client) and professions
---------------------------------------------------------------------------

function S.Talents()
	local lines = {}
	local specIndex = Try(C_SpecializationInfo and C_SpecializationInfo.GetSpecialization)
	if type(specIndex) == "number" and specIndex > 0 then
		local _, specName = Try(C_SpecializationInfo.GetSpecializationInfo, specIndex)
		if type(specName) == "string" and specName ~= "" then table.insert(lines, "Specialization: " .. Clean(specName, 40)) end
	end
	local configID = Try(C_ClassTalents and C_ClassTalents.GetActiveConfigID)
	local config = configID and Try(C_Traits and C_Traits.GetConfigInfo, configID)
	if type(config) == "table" and type(config.treeIDs) == "table" then
		local groups, order, total = {}, {}, 0
		for _, treeID in ipairs(config.treeIDs) do
			for _, nodeID in ipairs(Try(C_Traits.GetTreeNodes, treeID) or {}) do
				local node = Try(C_Traits.GetNodeInfo, configID, nodeID)
				local rank = type(node) == "table" and (node.ranksPurchased or node.activeRank) or 0
				if type(rank) == "number" and rank > 0 and type(node.activeEntry) == "table" and node.activeEntry.entryID then
					local entry = Try(C_Traits.GetEntryInfo, configID, node.activeEntry.entryID)
					local def = type(entry) == "table" and entry.definitionID and Try(C_Traits.GetDefinitionInfo, entry.definitionID)
					local name = type(def) == "table" and (def.overrideName ~= "" and def.overrideName or nil)
					if not name and type(def) == "table" and def.spellID then name = Try(C_Spell and C_Spell.GetSpellName, def.spellID) end
					if type(name) == "string" and name ~= "" then
						local group = "Talents"
						if node.subTreeID then
							local sub = Try(C_Traits.GetSubTreeInfo, configID, node.subTreeID)
							if type(sub) == "table" and type(sub.name) == "string" and sub.name ~= "" then group = sub.name end
						end
						if not groups[group] then groups[group] = { points = 0, names = {} }; table.insert(order, group) end
						groups[group].points = groups[group].points + rank
						table.insert(groups[group].names, Clean(name, 40) .. (rank > 1 and (" " .. rank) or ""))
						total = total + rank
					end
				end
			end
		end
		for _, group in ipairs(order) do
			local g = groups[group]
			table.insert(lines, group .. " (" .. g.points .. " points): " .. table.concat(g.names, ", "))
		end
		if total == 0 then table.insert(lines, "Talents: none spent") end
	else
		-- Older clients: talent tabs with points spent.
		local tabs = Try(GetNumTalentTabs)
		if type(tabs) == "number" and tabs > 0 then
			local parts = {}
			for i = 1, tabs do
				local tname, _, points = Try(GetTalentTabInfo, i)
				if type(tname) == "string" and type(points) == "number" then table.insert(parts, tname .. " " .. points) end
			end
			if #parts > 0 then table.insert(lines, "Talents: " .. table.concat(parts, " / ")) end
		end
	end
	return Fit(lines, S.BUDGET.talents)
end

-- A skill line from C_SkillInfo, which may answer with a table or a list of values.
local function SkillLine(i)
	local a, b, _, d, _, _, g = Try(C_SkillInfo.GetSkillLineInfo, i)
	if type(a) == "table" then
		return a.skillLineName or a.name, a.isHeader, a.skillLineRank or a.skillRank or a.rank, a.skillLineMaxRank or a.skillMaxRank or a.maxRank
	end
	return a, b, d, g
end

function S.Professions()
	local parts = {}
	local indices = { Try(GetProfessions) }
	for k = 1, 5 do
		local index = indices[k]
		if type(index) == "number" then
			local name, _, rank, maxRank = Try(GetProfessionInfo, index)
			if type(name) == "string" then
				table.insert(parts, name .. (rank and (" " .. tostring(rank) .. (maxRank and ("/" .. tostring(maxRank)) or "")) or ""))
			end
		end
	end
	if #parts == 0 then
		-- Skill lines under the Professions and Secondary Skills headers.
		local numLines, lineInfo = nil, nil
		if C_SkillInfo and type(C_SkillInfo.GetNumSkillLines) == "function" then
			numLines, lineInfo = Try(C_SkillInfo.GetNumSkillLines), SkillLine
		else
			numLines = Try(GetNumSkillLines)
			lineInfo = function(i)
				local a, b, _, d, _, _, g = Try(GetSkillLineInfo, i)
				return a, b, d, g
			end
		end
		if type(numLines) == "number" then
			local header
			local wanted = { [TRADE_SKILLS or "Professions"] = true, [SECONDARY_SKILLS or "Secondary Skills"] = true }
			for i = 1, math.min(numLines, 80) do
				local sname, isHeader, rank, maxRank = lineInfo(i)
				if type(sname) == "string" then
					if isHeader then header = sname
					elseif header and wanted[header] then
						table.insert(parts, sname .. (rank and (" " .. tostring(rank) .. (maxRank and ("/" .. tostring(maxRank)) or "")) or ""))
					end
				end
			end
		end
	end
	if #parts == 0 then return "" end
	return Fit({ "Professions: " .. table.concat(parts, ", ") }, S.BUDGET.prof)
end

---------------------------------------------------------------------------
-- Flight paths: read when the flight map opens, cached per map by the caller
---------------------------------------------------------------------------

-- Returns the map id and { names } of the flight paths this character knows there.
function S.TaxiNodes()
	local mapId = Try(GetTaxiMapID)
	local names, current = {}, nil
	local nodes = mapId and Try(C_TaxiMap and C_TaxiMap.GetAllTaxiNodes, mapId)
	if type(nodes) == "table" then
		local unreachable = Enum and Enum.FlightPathState and Enum.FlightPathState.Unreachable or 2
		local here = Enum and Enum.FlightPathState and Enum.FlightPathState.Current or 0
		for _, node in ipairs(nodes) do
			if type(node) == "table" and type(node.name) == "string" and node.state ~= unreachable then
				table.insert(names, Clean(node.name, 60))
				if node.state == here then current = Clean(node.name, 60) end
			end
		end
	else
		for i = 1, math.min(Try(NumTaxiNodes) or 0, 150) do
			local kind = Try(TaxiNodeGetType, i)
			local name = Try(TaxiNodeName, i)
			if type(name) == "string" and (kind == "REACHABLE" or kind == "CURRENT") then
				table.insert(names, Clean(name, 60))
				if kind == "CURRENT" then current = Clean(name, 60) end
			end
		end
	end
	table.sort(names)
	return mapId or 0, names, current
end

-- known: { [mapId] = { names } }, as cached by the caller.
function S.Taxi(known)
	local names, seen = {}, {}
	for _, list in pairs(known or {}) do
		for _, n in ipairs(list) do
			if not seen[n] then seen[n] = true; table.insert(names, n) end
		end
	end
	if #names == 0 then return "" end
	table.sort(names)
	local line = "Known flight paths (" .. #names .. "): " .. table.concat(names, "; ")
	return Clean(line, S.BUDGET.taxi)
end

---------------------------------------------------------------------------
-- Gear, durability and bag space
---------------------------------------------------------------------------

local SLOTS = {
	{ 1, "Head" }, { 2, "Neck" }, { 3, "Shoulder" }, { 15, "Back" }, { 5, "Chest" }, { 9, "Wrist" },
	{ 10, "Hands" }, { 6, "Waist" }, { 7, "Legs" }, { 8, "Feet" }, { 11, "Ring" }, { 12, "Ring" },
	{ 13, "Trinket" }, { 14, "Trinket" }, { 16, "Main hand" }, { 17, "Off hand" }, { 18, "Ranged" },
}

-- Returns the section text, the lowest durability percent and the free/total bag slots.
function S.Gear()
	local items, worst = {}, {}
	local lowest
	for _, slot in ipairs(SLOTS) do
		local link = Try(GetInventoryItemLink, "player", slot[1])
		if type(link) == "string" then
			local name = link:match("%[(.-)%]") or Try(C_Item and C_Item.GetItemInfo, link)
			local ilvl = Try(C_Item and C_Item.GetDetailedItemLevelInfo, link)
			if type(ilvl) ~= "number" then ilvl = select(4, Try(C_Item and C_Item.GetItemInfo, link)) end
			if name then table.insert(items, slot[2] .. " " .. Clean(name, 40) .. (type(ilvl) == "number" and (" (" .. ilvl .. ")") or "")) end
		end
		local cur, max = Try(GetInventoryItemDurability, slot[1])
		if type(cur) == "number" and type(max) == "number" and max > 0 then
			local pct = math.floor(cur / max * 100 + 0.5)
			if not lowest or pct < lowest then lowest = pct end
			if pct <= 30 then table.insert(worst, slot[2] .. " " .. pct .. "%") end
		end
	end
	local lines = {}
	local avg = Try(GetAverageItemLevel)
	if type(avg) == "number" and avg > 0 then table.insert(lines, string.format("Average item level: %.0f", avg)) end
	if #worst > 0 then table.insert(lines, "Low durability: " .. table.concat(worst, ", ")) end
	local free, total = 0, 0
	for bag = 0, 4 do
		local slots = Try(C_Container and C_Container.GetContainerNumSlots, bag)
		local n, family = Try(C_Container and C_Container.GetContainerNumFreeSlots, bag)
		if type(slots) == "number" and slots > 0 and (family == nil or family == 0) then
			total = total + slots
			free = free + (type(n) == "number" and n or 0)
		end
	end
	if total > 0 then table.insert(lines, "Bags: " .. free .. " of " .. total .. " slots free") end
	if #items > 0 then table.insert(lines, Clean("Equipped: " .. table.concat(items, "; "), S.BUDGET.gear - 150)) end
	return Fit(lines, S.BUDGET.gear), lowest, free, total
end

---------------------------------------------------------------------------
-- Small reads for the spoken announcements (WoWClaude.lua decides when)
---------------------------------------------------------------------------

-- Free and total slots in the regular bags.
function S.BagSpace()
	local free, total = 0, 0
	for bag = 0, 4 do
		local slots = Try(C_Container and C_Container.GetContainerNumSlots, bag)
		local n, family = Try(C_Container and C_Container.GetContainerNumFreeSlots, bag)
		if type(slots) == "number" and slots > 0 and (family == nil or family == 0) then
			total = total + slots
			free = free + (type(n) == "number" and n or 0)
		end
	end
	return free, total
end

-- The most worn equipped item: percent and slot name, or nil.
function S.LowestDurability()
	local lowest, where
	for _, slot in ipairs(SLOTS) do
		local cur, max = Try(GetInventoryItemDurability, slot[1])
		if type(cur) == "number" and type(max) == "number" and max > 0 then
			local pct = math.floor(cur / max * 100 + 0.5)
			if not lowest or pct < lowest then lowest, where = pct, slot[2] end
		end
	end
	return lowest, where
end

-- Names of the spells that become available at this level (to learn at the trainer).
function S.LevelSpells(level)
	local names = {}
	local ids = Try(C_SpellBook and C_SpellBook.GetCurrentLevelSpells, level)
	if type(ids) == "table" then
		for _, id in ipairs(ids) do
			local name = Try(C_Spell and C_Spell.GetSpellName, id)
			if type(name) == "string" and name ~= "" then table.insert(names, Clean(name, 40)) end
			if #names >= 8 then break end
		end
	end
	return names
end

-- Title, story text and objectives of a quest in the log, for narration.
function S.QuestStory(questId)
	local title = Try(C_QuestLog and C_QuestLog.GetTitleForQuestID, questId)
	local index = Try(C_QuestLog and C_QuestLog.GetLogIndexForQuestID, questId)
	local description, objectives
	if type(index) == "number" then description, objectives = Try(GetQuestLogQuestText, index) end
	return Clean(title or "", 80), Clean(description or "", 1000), Clean(objectives or "", 300)
end
