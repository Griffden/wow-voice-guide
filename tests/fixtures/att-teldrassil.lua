---------------------------------------------------
--          Z O N E S        M O D U L E         --
---------------------------------------------------
-- A trimmed copy of the shapes AllTheThings uses (MIT, ATTWoWAddon/AllTheThings).
local SHARED_COORDS = { 50.0, 50.0, MAP.TELDRASSIL };
maproot(MAP.KALIMDOR, MAP.TELDRASSIL, {
	["groups"] = {
		m(SHADOWGLEN, {
			["groups"] = {
				n(QUESTS, {
					q(3519, {	-- A Friend in Need
						["sourceQuest"] = 4495,	-- A Good Friend
						["qg"] = 8584,	-- Iverron
						["coord"] = { 54.6, 33.0, MAP.TELDRASSIL },
						["races"] = ALLIANCE_ONLY,
						["lvl"] = 2,
					}),
					q(4495, {	-- A Good Friend
						["qg"] = 8583,	-- Dirania Silvershine
						["coord"] = { 60.8, 42.0, MAP.TELDRASSIL },
						["races"] = ALLIANCE_ONLY,
						["lvl"] = 2,
						["OnTooltip"] = function(t, tooltipInfo)
							if t.questID then return "end" end
						end,
					}),
					q(5622, {	-- In Favor of Elune
						["qg"] = 3595,	-- Shanda <Priest Trainer>
						["coord"] = { 59.2, 40.4, MAP.TELDRASSIL },
						["races"] = { NIGHTELF },
						["classes"] = { PRIEST },
						["isBreadcrumb"] = true,
						["lvl"] = lvlsquish(5, 5, 3),
					}),
					q(9999, {	-- Removed in Forever
						["qg"] = 1,	-- Nobody
						["coord"] = { 10.0, 10.0, MAP.TELDRASSIL },
						["timeline"] = { REMOVED_1_15_3 },
					}),
					q(9998, {	-- Only in Season of Discovery
						-- #if SEASON_OF_DISCOVERY
						["qg"] = 2,	-- Seasonal
						-- #else
						["qg"] = 3,	-- Everyone
						-- #endif
						["coord"] = SHARED_COORDS,
					}),
				}),
			},
		}),
		n(QUESTS, bubbleDown({ ["timeline"] = { ADDED_1_15_3 } }, {
			q(2159, {	-- Dolanaar Delivery
				["qgs"] = {
					6780,	-- Porthannius
					6781,	-- Second Porthannius
				},
				["coords"] = {
					{ 61.2, 47.6, MAP.TELDRASSIL },
					{ 70.0, 20.0, DARKSHORE },
				},
				["lvl"] = { 4, 10 },
			}),
			{	-- Tome of the Cabal
				["allianceQuestData"] = q(1758, {	-- Tome of the Cabal (A)
					["sourceQuests"] = { 1798, 1799 },	-- Seeking Strahad
					["sourceQuestNumRequired"] = 1,
				}),
				["hordeQuestData"] = q(1801, {	-- Tome of the Cabal (H)
					["qg"] = 3326,	-- Zevrost
				}),
			},
			cl(WARLOCK, {
				q(1470, {	-- Piercing the Veil
					["qg"] = 459,	-- Drusilla La Salle
					["coord"] = { 44.4, 66.2, 999999 },
				}),
			}),
		})),
	},
});
