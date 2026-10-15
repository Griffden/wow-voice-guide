-- WoW Voice Guide + Polestar (github.com/fitzforge/polestar), when installed.
--
-- Polestar plans the leveling route and leads its arrow; the voice guide
-- reads the route out and answers questions about it. This file uses only
-- Polestar's public interface (its docs/ARCHITECTURE.md): the global
-- `Polestar` table, its message bus (Polestar.On) and the Engine's read and
-- navigation functions. Every call is guarded, so a missing function, or one
-- that errors after a Polestar update, just leaves its part out.
--
-- Nothing here writes Polestar's saved data or acts for the player on its
-- own. The only calls that change anything are the guide navigation the
-- player asked for by voice (skip, undo, back, ahead, aim the arrow, open a
-- guide), the same Engine calls Polestar's own buttons make.
--
--   P.Section()        the "polestar" game state section (WoWClaude.lua sends it)
--   P.Hook()           at login: subscribe to Polestar's messages
--   P.Act(action, arg) a voice command, from a reply's `polestar` field
--   P.DumpText()       the raw step view, to check Polestar's shape in game

WoWClaude_Polestar = {}
local P = WoWClaude_Polestar
local S = WoWClaude_State
local Try, Clean = S.Try, S.Clean

P.BUDGET = 1000
local NARRATE_DELAY = 2 -- seconds: goals that tick off together are spoken once
local SKIPS_KEPT = 300 -- seconds a quest Polestar skipped stays in the section
local SKIPS_MAX = 4

function P.Ready()
	return type(Polestar) == "table" and type(Polestar.Engine) == "table" and type(Polestar.Engine.GetStepView) == "function"
end

-- Polestar.<group>.<name>(...), protected; nothing when it is missing.
local function Call(group, name, ...)
	local t = type(Polestar) == "table" and Polestar[group]
	return Try(type(t) == "table" and t[name], ...)
end

local function MapName(map)
	if type(map) ~= "number" then return nil end
	local name = Call("Compat", "MapName", map)
	if type(name) == "string" and name ~= "" then return name end
	local info = Try(C_Map and C_Map.GetMapInfo, map)
	return type(info) == "table" and type(info.name) == "string" and info.name or nil
end

-- Polestar positions are 0-100 on `map`. With `f` they are in another frame
-- (Era coordinates); Polestar's Compat converts them to the live map.
local function LiveXY(map, x, y, f)
	if type(map) ~= "number" or type(x) ~= "number" or type(y) ~= "number" then return nil end
	if f == nil then return x, y end
	local c, wx, wy = Call("Compat", "MapToWorld", map, x, y, f)
	if c == nil then return nil end
	local lx, ly = Call("Compat", "WorldToMap", c, wx, wy, map)
	if type(lx) == "number" and type(ly) == "number" then return lx, ly end
end

-- "Durotar 45.2, 60.1", or just the map name when the spot can't be placed.
local function Place(map, x, y, f)
	local where = MapName(map)
	local lx, ly = LiveXY(map, x, y, f)
	if where and lx then return string.format("%s %.1f, %.1f", where, lx, ly) end
	return where
end

local function GuideTitle(id)
	local g = id and Call("Guides", "Get", id)
	return type(g) == "table" and g.title and Clean(g.title, 80) or (id and Clean(id, 80)) or nil
end

-- A goal as the guide window shows it: "Kill Mottled Boar 3/8", with its
-- detail ("for Cutting Teeth") when asked. No ";": lists are joined by it.
local function GoalText(g, withDetail)
	local text = g.text or ((g.verb or "") .. " " .. tostring(g.subject or ""))
	text = Clean(text, 90)
	local p = g.progress
	if type(p) == "table" and type(p.cur) == "number" and type(p.max) == "number" and p.max > 0 then
		text = text .. " " .. p.cur .. "/" .. p.max
	end
	if withDetail and type(g.detail) == "string" and g.detail ~= "" then text = text .. " " .. Clean(g.detail, 60) end
	return (text:gsub(";", ","))
end

local function IsOpen(g)
	return g.status ~= "done" and g.status ~= "skipped" and g.status ~= "na"
end

-- The goals a step shows as rows, in order: { { index, g }, ... }.
local function Rows(view)
	local rows = {}
	for gi, g in ipairs(type(view) == "table" and type(view.goals) == "table" and view.goals or {}) do
		if type(g) == "table" and not g.folded and g.status ~= "na" then table.insert(rows, { index = gi, g = g }) end
	end
	return rows
end

---------------------------------------------------------------------------
-- What Polestar shows now
---------------------------------------------------------------------------

-- nil without Polestar; { none = true } with no guide open; else the guide,
-- the step shown and its live step, who to see now and what to do there.
function P.Snapshot()
	if not P.Ready() then return nil end
	local guide = Call("Engine", "GetGuide")
	if type(guide) ~= "table" then return { none = true } end
	local snap = { guideId = guide.id, guide = Clean(guide.title or guide.id or "a guide", 80), now = {}, rest = {} }
	snap.count = Call("Engine", "GetStepCount") or 0
	snap.done, snap.total = Call("Engine", "GetProgress")
	snap.step = Call("Engine", "GetStepIndex")
	snap.live = Call("Engine", "GetLiveStep")
	local view = type(snap.step) == "number" and Call("Engine", "GetStepView", snap.step)
	if type(view) == "table" then
		snap.title = type(view.title) == "string" and Clean(view.title, 80) or nil
		snap.note = type(view.note) == "string" and Clean(view.note, 160) or nil
		snap.skipped = view.skipped and true or false
		local goals = type(view.goals) == "table" and view.goals or {}
		local groups = type(view.groups) == "table" and view.groups or {}
		snap.focus = type(view.focus) == "number" and view.focus or nil
		local focus = snap.focus and groups[snap.focus]
		-- "Person 2 of 8": the step's NPCs and objects, the focus among them.
		local persons, person = 0, nil
		for k, grp in ipairs(groups) do
			if type(grp) == "table" and grp.kind ~= "here" then
				persons = persons + 1
				if k == snap.focus then person = persons end
			end
		end
		if type(focus) == "table" and focus.kind ~= "here" and type(focus.name) == "string" then
			snap.who, snap.person, snap.persons = Clean(focus.name, 60), person, persons
		end
		-- Who (or what) comes after the focus.
		for k = (snap.focus or #groups) + 1, #groups do
			local grp = groups[k]
			if type(grp) == "table" and not grp.done then
				if grp.kind ~= "here" and type(grp.name) == "string" then
					snap.after = Clean(grp.name, 60)
				else
					for _, gi in ipairs(type(grp.goals) == "table" and grp.goals or {}) do
						local g = goals[gi]
						if type(g) == "table" and not g.folded and IsOpen(g) then snap.after = GoalText(g, true); break end
					end
				end
				if snap.after then break end
			end
		end
		local inFocus = {}
		for _, gi in ipairs(type(focus) == "table" and type(focus.goals) == "table" and focus.goals or {}) do inFocus[gi] = true end
		for _, r in ipairs(Rows(view)) do
			local g = r.g
			if inFocus[r.index] and IsOpen(g) then
				-- At a person, "from Gornek" would repeat the name.
				table.insert(snap.now, GoalText(g, not snap.who) .. (g.optional and " (optional)" or ""))
			else
				local tag = ""
				if g.status == "done" then tag = " - done"
				elseif g.status == "skipped" then
					tag = " - skipped" .. (type(g.unavailableText) == "string" and (": " .. Clean(g.unavailableText, 80)) or "")
				elseif g.optional then tag = " (optional)" end
				table.insert(snap.rest, GoalText(g, true) .. tag)
			end
		end
	end
	local wp = Call("Engine", "GetWaypoint")
	if type(wp) == "table" then
		local where = Place(wp.map, wp.x, wp.y, wp.f)
		local label = type(wp.label) == "string" and Clean(wp.label, 80) or ""
		if label ~= "" or where then snap.arrow = label .. ((label ~= "" and where) and ", " or "") .. (where or "") end
	end
	local tabs, active = Call("Engine", "GetTabs")
	if type(tabs) == "table" then
		snap.others = {}
		for i, t in ipairs(tabs) do
			if i ~= active and type(t) == "table" then
				local state = t.complete and " (complete)" or (" (step " .. tostring(t.stepIndex or "?") .. " of " .. tostring(t.stepCount or "?") .. ")")
				table.insert(snap.others, Clean(t.title or t.guideId or "a guide", 50) .. state)
			end
		end
	end
	local from = Call("Engine", "PendingRouteChoice")
	if from then
		local choice = Call("Engine", "GetRouteChoice", from)
		if type(choice) == "table" and type(choice.options) == "table" then
			snap.choice = {}
			for _, o in ipairs(choice.options) do
				if type(o) == "table" and o.title then table.insert(snap.choice, Clean(o.title, 50) .. (o.recommended and " (recommended)" or "")) end
			end
		end
	end
	return snap
end

local function Join(list, max)
	return Clean(table.concat(list, "; "), max)
end

-- The "polestar" section. bridge/polestar.js reads these line prefixes.
function P.Section(snap)
	snap = snap or P.Snapshot()
	if not snap then return "" end
	if snap.none then return "Polestar guide: installed, no guide open" end
	local lines = {}
	local head = "Polestar guide: " .. snap.guide
	if type(snap.step) == "number" then
		head = head .. " (step " .. snap.step .. " of " .. snap.count
		if type(snap.done) == "number" and type(snap.total) == "number" then head = head .. ", " .. snap.done .. " of " .. snap.total .. " steps done" end
		head = head .. ")"
	else
		head = head .. " (complete)"
	end
	table.insert(lines, head)
	if snap.step and snap.live and snap.step ~= snap.live then
		table.insert(lines, "The player is looking at step " .. snap.step .. "; the guide is on step " .. snap.live)
	end
	if snap.title then table.insert(lines, "Step " .. snap.step .. ": " .. snap.title .. (snap.skipped and " (skipped by the player)" or "")) end
	if snap.who then
		table.insert(lines, "Now at: " .. snap.who .. ((snap.persons or 0) > 1 and (" (person " .. snap.person .. " of " .. snap.persons .. ")") or ""))
	end
	if #snap.now > 0 then table.insert(lines, "To do now: " .. Join(snap.now, 300)) end
	if snap.after then table.insert(lines, "Then: " .. snap.after) end
	if snap.arrow then table.insert(lines, "Arrow: " .. snap.arrow) end
	if snap.note then table.insert(lines, "Step note: " .. snap.note) end
	if snap.choice and #snap.choice > 0 then table.insert(lines, "Waiting for the player to choose the next guide: " .. Join(snap.choice, 200)) end
	local skips = {}
	for _, s in ipairs(P.skips or {}) do
		if GetTime() - s.at <= SKIPS_KEPT then table.insert(skips, s.text) end
	end
	if #skips > 0 then table.insert(lines, "Polestar skipped: " .. Join(skips, 250)) end
	if #snap.rest > 0 then table.insert(lines, "Rest of the step: " .. Join(snap.rest, 300)) end
	if snap.others and #snap.others > 0 then table.insert(lines, "Other Polestar guides open: " .. Join(snap.others, 200)) end
	return S.Fit(lines, P.BUDGET)
end

---------------------------------------------------------------------------
-- Narration: moments for the companion to speak (announce kind "polestar")
---------------------------------------------------------------------------

-- The step, or the person within it, moved on. The first look after login
-- only takes note; looking at another step with Prev/Next says nothing.
function P.CheckNarration()
	local snap = P.Snapshot()
	if not snap or snap.none or type(snap.step) ~= "number" then return end
	if snap.live and snap.step ~= snap.live then return end
	local stepKey = tostring(snap.guideId) .. ":" .. snap.step
	local key = stepKey .. ":" .. tostring(snap.focus or 0)
	local last = P.lastNarrated
	P.lastNarrated = key
	if last == nil or last == key then return end
	if #snap.now == 0 and not snap.who then return end
	local sameStep = last:sub(1, #stepKey + 1) == stepKey .. ":"
	WoWClaude.Announce("pstep", {
		{ "guide", snap.guide }, { "step", snap.step }, { "of", snap.count }, { "title", snap.title or "" },
		{ "who", snap.who or "" }, { "person", snap.person or "" }, { "persons", snap.persons or "" },
		{ "now", table.concat(snap.now, "; ") }, { "then", snap.after or "" }, { "same", sameStep and "1" or "" },
	})
end

local function Narrate()
	if P.narratePending or not C_Timer then return end
	P.narratePending = true
	C_Timer.After(NARRATE_DELAY, function()
		P.narratePending = nil
		WoWClaude.Guarded("polestar.narrate", P.CheckNarration)
	end)
end

local function Changed()
	WoWClaude.MarkState("polestar")
end

local HANDLERS = {
	GUIDE_CHANGED = function() Changed(); Narrate() end,
	STEP_CHANGED = function() Changed(); Narrate() end,
	STEP_UPDATED = function() Changed(); Narrate() end,
	WAYPOINT_CHANGED = Changed,
	TABS_CHANGED = Changed,
	ROUTE_CHOSEN = Changed,
	-- Skips from Polestar's own buttons too, so "undo skip" works for them.
	PLAYER_SKIPPED_STEP = function(guideId, step)
		if type(step) == "number" then P.lastSkip = { guide = guideId, step = step } end
		Changed()
	end,
	-- Quests Polestar found it can't offer any more: the guide moved past them.
	STEP_SKIPPED = function(_, _, list)
		local names = {}
		P.skips = P.skips or {}
		for _, q in ipairs(type(list) == "table" and list or {}) do
			if type(q) == "table" then
				local line = Clean(q.title or ("quest " .. tostring(q.quest or "?")), 60)
				if type(q.text) == "string" and q.text ~= "" then line = line .. " (" .. Clean(q.text, 90) .. ")" end
				line = line:gsub(";", ",")
				table.insert(P.skips, { at = GetTime(), text = line })
				table.insert(names, line)
			end
		end
		while #P.skips > SKIPS_MAX do table.remove(P.skips, 1) end
		Changed()
		if #names > 0 then WoWClaude.Announce("pskip", { { "quests", table.concat(names, "; ") } }) end
	end,
	GUIDE_COMPLETED = function(id)
		Changed()
		WoWClaude.Announce("pdone", { { "guide", GuideTitle(id) or "" } })
	end,
	ROUTE_CHOICE = function(fromId)
		Changed()
		local choice = Call("Engine", "GetRouteChoice", fromId)
		if type(choice) ~= "table" or type(choice.options) ~= "table" then return end
		local names = {}
		for _, o in ipairs(choice.options) do
			if type(o) == "table" and o.title then table.insert(names, (Clean(o.title, 50):gsub(";", ",")) .. (o.recommended and " (recommended)" or "")) end
		end
		WoWClaude.Announce("proute", { { "guide", choice.fromTitle or GuideTitle(fromId) or "" }, { "options", table.concat(names, "; ") } })
	end,
	TRAIN_DUE = function(level, trainer)
		local t = type(trainer) == "table" and trainer or {}
		WoWClaude.Announce("ptrain", { { "level", level or "" }, { "npc", t.npcName or "" }, { "where", MapName(t.map) or "" } })
	end,
	GUIDE_OUTLEVELED = function(id, suggested)
		WoWClaude.Announce("plevel", { { "guide", GuideTitle(id) or "" }, { "next", suggested and GuideTitle(suggested) or "" } })
	end,
}

-- At login (Polestar loads first: OptionalDeps). True once subscribed.
function P.Hook()
	if P.hooked then return true end
	if not P.Ready() or type(Polestar.On) ~= "function" then return false end
	P.hooked = true
	for msg, fn in pairs(HANDLERS) do
		pcall(Polestar.On, msg, function(...) WoWClaude.Guarded("polestar." .. msg, fn, ...) end)
	end
	Changed()
	-- Polestar may have placed its guide before we subscribed: take note now,
	-- so the first step change after login is spoken.
	Narrate()
	return true
end

---------------------------------------------------------------------------
-- Voice commands: the bridge recognises them and sends { action, arg }
---------------------------------------------------------------------------

local ORDINALS = {
	first = 1, second = 2, third = 3, fourth = 4, fifth = 5, sixth = 6, seventh = 7, eighth = 8, last = -1,
	["1st"] = 1, ["2nd"] = 2, ["3rd"] = 3, ["4th"] = 4, ["5th"] = 5, ["6th"] = 6, ["7th"] = 7, ["8th"] = 8,
	one = 1, two = 2, three = 3, four = 4, five = 5, six = 6, seven = 7, eight = 8,
}
local FILLER = { the = true, my = true, a = true, guide = true, guides = true, polestar = true, quest = true, goal = true }

local function Words(s)
	local out = {}
	for w in tostring(s or ""):lower():gmatch("[%w']+") do
		if not FILLER[w] then table.insert(out, w) end
	end
	return out
end

local function Matches(text, words)
	if #words == 0 then return false end
	local t = tostring(text or ""):lower()
	for _, w in ipairs(words) do
		if not t:find(w, 1, true) then return false end
	end
	return true
end

local function ShownStep()
	local step = Call("Engine", "GetStepIndex")
	local view = type(step) == "number" and Call("Engine", "GetStepView", step)
	if type(view) ~= "table" then return "Polestar has no step to show." end
	return "Polestar shows step " .. step .. (view.title and (": " .. Clean(view.title, 80)) or "") .. "."
end

local ACTIONS = {}

function ACTIONS.skip()
	local s = Call("Engine", "Skip")
	if not s then return "Polestar has no step to skip." end
	return "Polestar skipped step " .. s .. ". Say \"undo skip\" to bring it back."
end

function ACTIONS.unskip()
	local last = P.lastSkip
	local guide = Call("Engine", "GetGuide")
	if not last or type(guide) ~= "table" or guide.id ~= last.guide then return "There is no skipped step to bring back in this guide." end
	if not Call("Engine", "Unskip", last.step) then return "Polestar could not bring step " .. last.step .. " back." end
	P.lastSkip = nil
	return "Step " .. last.step .. " is open again."
end

function ACTIONS.back()
	Call("Engine", "Prev")
	return ShownStep()
end

function ACTIONS.ahead()
	Call("Engine", "Next")
	return ShownStep()
end

function ACTIONS.current()
	local live = Call("Engine", "GetLiveStep")
	if not live then return "This guide is complete." end
	Call("Engine", "Goto", live)
	return ShownStep()
end

-- A row of the current step by number ("the second one") or by name.
function ACTIONS.aim(arg)
	local step = Call("Engine", "GetStepIndex")
	local view = type(step) == "number" and Call("Engine", "GetStepView", step)
	if type(view) ~= "table" then return "Polestar has no step open." end
	local rows = Rows(view)
	local key = tostring(arg or ""):lower()
	local n = tonumber(key) or ORDINALS[key]
	local pick
	if n then
		pick = rows[n == -1 and #rows or n]
	else
		local words = Words(arg)
		for _, r in ipairs(rows) do
			local g = r.g
			if Matches((g.text or "") .. " " .. tostring(g.npcName or "") .. " " .. tostring(g.subject or ""), words) then pick = r; break end
		end
	end
	if not pick then return "No goal in this step matches \"" .. tostring(arg or "") .. "\"." end
	if Call("Engine", "AimGoal", step, pick.index) then return "Polestar's arrow now points at: " .. GoalText(pick.g) .. "." end
	return GoalText(pick.g) .. ": nowhere for the arrow to lead (done, or no place known)."
end

-- An open tab by title, else open the guide by title in a new tab.
function ACTIONS.guide(arg)
	local words = Words(arg)
	if #words == 0 then return "Which guide? Say its name, like \"switch to the mining guide\"." end
	local tabs = Call("Engine", "GetTabs")
	for i, t in ipairs(type(tabs) == "table" and tabs or {}) do
		if type(t) == "table" and Matches(t.title, words) then
			Call("Engine", "SelectTab", i)
			return "Polestar switched to " .. Clean(t.title, 60) .. "."
		end
	end
	local best
	for _, h in ipairs(Call("Guides", "List") or {}) do
		if type(h) == "table" and h.id and Matches(h.title, words) and (not best or #tostring(h.title) < #tostring(best.title)) then best = h end
	end
	if not best then return "Polestar has no guide called \"" .. tostring(arg) .. "\"." end
	if Call("Engine", "OpenTab", best.id) then return "Polestar opened " .. Clean(best.title, 60) .. "." end
	return "Polestar could not open " .. Clean(best.title, 60) .. ": six guides are open, close one first."
end

-- Returns a line for the chat. In combat Polestar's windows can't change, so
-- the command waits for PLAYER_REGEN_ENABLED (AfterCombat).
function P.Act(action, arg)
	local fn = ACTIONS[action]
	if not fn then return "Unknown Polestar command: " .. tostring(action) .. "." end
	if not P.Ready() then return "Polestar is not loaded." end
	if InCombatLockdown and InCombatLockdown() then
		P.afterCombat = { action = action, arg = arg }
		return "In combat: Polestar will do that when combat ends."
	end
	local ok, msg = pcall(fn, arg)
	if not ok then return "Polestar could not do that (" .. Clean(tostring(msg), 120) .. ")." end
	Changed()
	return msg
end

function P.AfterCombat()
	local pending = P.afterCombat
	P.afterCombat = nil
	if pending then print("WoW Voice Guide: " .. tostring(P.Act(pending.action, pending.arg))) end
end

---------------------------------------------------------------------------
-- /wow-claude polestar dump: the raw shapes, to check them against a real client
---------------------------------------------------------------------------

local function KeyRank(k)
	local t = type(k)
	return t == "number" and 1 or t == "string" and 2 or 3
end

local function KeyLess(a, b)
	local ra, rb = KeyRank(a), KeyRank(b)
	if ra ~= rb then return ra < rb end
	if ra < 3 then return a < b end
	return tostring(a) < tostring(b)
end

local function Serialize(v, indent, seen)
	local t = type(v)
	if t == "string" then return string.format("%q", Clean(v, 160)) end
	if t ~= "table" then return tostring(v) end
	if seen[v] then return "{ --[[seen]] }" end
	if indent >= 6 then return "{ --[[deeper]] }" end
	seen[v] = true
	local keys = {}
	for k in pairs(v) do table.insert(keys, k) end
	if #keys == 0 then return "{}" end
	table.sort(keys, KeyLess)
	local pad = string.rep("  ", indent + 1)
	local parts = {}
	for i, k in ipairs(keys) do
		if i > 60 then table.insert(parts, pad .. "-- " .. (#keys - 60) .. " more"); break end
		local key = type(k) == "number" and ("[" .. k .. "]") or (type(k) == "string" and k:match("^[%a_][%w_]*$") and k) or ("[" .. string.format("%q", tostring(k)) .. "]")
		table.insert(parts, pad .. key .. " = " .. Serialize(v[k], indent + 1, seen))
	end
	return "{\n" .. table.concat(parts, ",\n") .. ",\n" .. string.rep("  ", indent) .. "}"
end

function P.DumpText()
	if not P.Ready() then return "Polestar is not loaded." end
	local version = Try(C_AddOns and C_AddOns.GetAddOnMetadata, "Polestar", "Version")
	local step = Call("Engine", "GetStepIndex")
	local guide = Call("Engine", "GetGuide")
	local tabs, active = Call("Engine", "GetTabs")
	local out = {
		"-- Polestar " .. tostring(version or "?") .. ", guide " .. tostring(type(guide) == "table" and guide.id or "none")
			.. ", step " .. tostring(step) .. " (live " .. tostring(Call("Engine", "GetLiveStep")) .. ")",
		"view = " .. Serialize(type(step) == "number" and Call("Engine", "GetStepView", step) or nil, 0, {}),
		"waypoint = " .. Serialize(Call("Engine", "GetWaypoint"), 0, {}),
		"tabs = " .. Serialize(tabs, 0, {}) .. " -- active " .. tostring(active),
		"-- section as the voice guide sends it:",
		"--[[\n" .. P.Section() .. "\n]]",
	}
	return table.concat(out, "\n")
end
