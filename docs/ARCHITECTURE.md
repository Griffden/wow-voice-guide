# Architecture

## Components

```text
WoW add-on                         Electron companion
-----------                        ------------------
Talk button -- pixel strip ------> capture.ps1 -> bridge worker
                                          |
                                          +-> renderer microphone (16 kHz PCM)
                                          +-> Deepgram Flux /v2/listen
                                          +-> selected guide LLM <-> Wowhead Forever data, web search
                                          +-> Fish Audio streaming TTS -> renderer playback
                                          |
answer <---- load-on-demand slot ----------+
```

WoW's Lua sandbox has no general network, microphone, or arbitrary runtime file APIs. The companion is therefore a required boundary component. Deepgram, the LLM host, Wowhead, and Fish Audio are remote services called by that one companion.

The desktop main process owns credentials, provider sockets, bridge supervision, and WAV file access. The renderer is context-isolated and receives only a narrow preload API for configuration, microphone PCM, status, and playback.

## Outbound game protocol

The add-on draws a checksummed byte stream as RGB values in 4-pixel cells. `capture.ps1` reads the client window with Windows Graphics Capture and emits decoded JSON records.

Records use ASCII record separator (`0x1e`) and unit separator (`0x1f`):

```text
session, chat, id, cwd, flags, name, [context,] text
```

Relevant flags:

- `h`: hello/connection handshake
- `s`: a game state field is present (see below)
- `c`: a single game-context string is present (older add-ons and the reload-mode outbox)
- `a`: an announcement moment; the text holds `key GS value` fields (see Announcements below)
- `ann=quest:1,zone:0`: the player switched announcements in game
- `d`: forget the chat
- `v`: start a voice turn
- `x`: cancel a voice turn (reserved by the worker protocol)

### Game state sections

The companion can never ask the game anything mid-answer: replies travel back through load-on-demand slots, which are slow. The add-on therefore pushes what the guide may need, as named text sections, whenever the game events behind them fire (`addon/WoWClaude/GameState.lua` builds them, `WoWClaude.lua` marks them dirty and sends them):

| Section | Holds | Refreshed on |
|---|---|---|
| `char` | game and client, character, hearthstone | login, `PLAYER_LEVEL_UP`, `HEARTHSTONE_BOUND` |
| `prog` | money, XP, rested XP | XP, money and resting events (30 s debounce) |
| `loc` | zone, subzone, map position | zone changes; moving 3 map units; every question |
| `quest` | selected/tracked quest: status (`ReadyForTurnIn`), objectives, `GetNextWaypointText`, instructions, turn-in text, description | quest log and tracking events |
| `quests` | every quest in the log with objective progress or "ready to turn in" | `QUEST_LOG_UPDATE` (4 s debounce), accept, remove, turn-in |
| `npc` | NPC name, what they say, quests offered/active with IDs, dialog options | `GOSSIP_SHOW`, `QUEST_GREETING`, `QUEST_DETAIL`, `QUEST_PROGRESS`, `QUEST_COMPLETE` |
| `target` | name, level, classification, creature type, reaction, NPC id (never health) | `PLAYER_TARGET_CHANGED` |
| `talents` | specialization and spent talents per sub-tree (`C_ClassTalents`, `C_Traits`) | `TRAIT_CONFIG_UPDATED`, `PLAYER_TALENT_UPDATE` |
| `prof` | professions (`GetProfessions`, else `C_SkillInfo`) | `SKILL_LINES_CHANGED` |
| `taxi` | known flight paths, cached per continent | `TAXIMAP_OPENED` |
| `gear` | equipped items and item levels, low durability, free bag slots | equipment, durability and bag events |
| `done.N`, `done.new` | completed quest IDs (`GetAllCompletedQuestIDs`), then turn-ins since | once per session, `QUEST_TURNED_IN` |

A section record has flags `s` and its context field holds `key GS value` pairs joined by `FS` (ASCII 0x1D / 0x1C). An empty value deletes a section; the key `*` clears them all (context off, or the start of the full resend that follows every hello). Only sections whose text changed are sent, each record stays under 1.5 KB, and a question is always preceded by a record with the current position. Completed quest IDs are sent as sorted runs in base 36 with deltas (`a~3,11` = 10–13 and 50), chunked so each chunk decodes on its own; a few hundred completed quests take well under 1 KB.

Section records carry no text and never escalate to the reload fallback. They leave the strip once acknowledged, or after three seconds on screen when the sound-file channel is unavailable (the bridge reads the strip four times a second). Nothing is sent while the bridge is away; the next hello sends everything.

`bridge/gamestate.js` merges the sections into `state.json`. For each question it assembles the model's context from them within `gameContextMaxChars` (default 3,500): every section that fits, rendered in a fixed order, with the ones the question is about winning the budget (talents for a talent question, gear for "do I need to repair?", the NPC dialog for "what is he asking?"). A dialog older than 30 minutes is left out. Completed quest IDs are not sent to the model; the guide's quest tools use them.

For a voice turn, the worker acknowledges the request and asks the Electron main process to start Flux. The renderer starts its microphone only after the WebSocket opens. About 85 ms of browser audio at a time is converted to mono signed 16-bit 16 kHz PCM. `EndOfTurn` supplies the final transcript; `ForceEndTurn` supports the manual finish button.

## Brain and response contract

The worker combines the current transcript with recent local chat messages and the game context assembled from the latest game state sections, then calls `Providers.requestGuideAnswer` for every question:

```text
question + game context (character, zone, position, quest log with quest IDs)
  |
  +-> 1. quest-log lookup (bridge/wowdata.js, every preset)
  |      quests the question names, or the selected quest for "where do I go?"
  |      -> Wowhead Forever tooltip (objectives, turn-in) + search (quest text, level, zone)
  |
  +-> 1b. "what should I do?" questions (every preset): the quests available
  |       nearby, from the offline quest database (bridge/questdb.js)
  |
  +-> 2a. OpenAI preset: tool-using guide (Responses API, store: false)
  |        tools: quests_near_me(zone)       offline: quests to pick up here, nearest giver first
  |               quest_info(quest)          offline: one quest's givers, coordinates, prerequisites
  |               wowhead_search(query)      name -> Forever quests/NPCs/items/spells/zones + ids
  |               wowhead_lookup(type, id)   one entry; NPCs include zone + map coordinates
  |               web_search                 live web for guides, routes, list questions
  |        up to playerGuide.maxRounds model calls; the last one cannot call tools
  |
  +-> 2b. Gemini / local preset: one Chat Completions or generateContent call
  |        with the step-1 quest notes and nearby quests in the system prompt
  |
  +-> 3. label + sources + waypoint
```

The model decides which lookups a question needs. There is no keyword router, and answers are not discarded for lacking a matching source. Instead, every answer reports a `basis`:

| basis | Meaning | Spoken label |
|---|---|---|
| `game` | Player's own game context, the conversation, or small talk | none, no sources shown |
| `forever` | Wowhead Forever data or a Forever-specific page | none |
| `classic` | Classic or Vanilla information for the same quest or place | "Based on Classic info, which may differ in Forever:" (omitted when the player asked about Classic) |
| `general` | General WoW knowledge without a source | "I couldn't confirm this for Forever, so this is from general WoW knowledge:" |

A `forever` or `classic` basis with nothing looked up (no quest notes, tool calls, or web search) is downgraded to `general`. Sources are the pages cited by web search, the Wowhead entries the model opened, the step-1 quest notes, and search hits the answer names by title.

The tool-using guide returns:

```json
{
  "speech": "answer to speak, without URLs or Markdown",
  "basis": "game | forever | classic | general",
  "waypoint": { "zone": "Darkshore", "x": 35.6, "y": 43.4, "label": "Cerellean Whiteclaw", "sourceUrl": "https://www.wowhead.com/forever/npc=3644" }
}
```

A waypoint is kept only if its `sourceUrl` is something a lookup or search actually returned and its label matches the conversation. The zone becomes an in-game map ID through the player's current map or `bridge/zones.json` (Wowhead zone id -> uiMapID, generated from the Forever 1.60.1.70009 `UiMap`/`UiMapAssignment` tables on wago.tools, including new Forever zones). If the model omits the waypoint but the answer names exactly one looked-up NPC with coordinates, the worker builds the waypoint from that lookup.

The Gemini/local presets are asked for:

```json
{
  "display": "concise in-game answer",
  "speech": "natural spoken answer",
  "basis": "game | forever | classic | general",
  "waypoint": { "mapId": 1431, "x": 0.452, "y": 0.678, "label": "Darkshire" }
}
```

Malformed JSON degrades to plain text with a `general` basis. Waypoints are normalized and rejected unless the map ID and normalized coordinates are valid. The player must still click **Set waypoint** in the add-on.

### Forever game data

Blizzard offers no web API for WoW: Forever during the beta. `bridge/wowdata.js` reads the two public JSON endpoints behind Wowhead's own tooltips and search box:

- `https://nether.wowhead.com/forever/tooltip/{quest|npc|item|spell|zone|object}/{id}`
- `https://www.wowhead.com/forever/search/suggestions-template?q={name}`

Responses are cached in memory for six hours (at most 500 entries) and each request times out after six seconds. Tool failures are returned to the model as `{ "error": ... }` so it can try another lookup or answer with a label. Wowhead's beta data is incomplete (some NPCs have no location), and a "which quests start here?" list can only be approximated from search and the web.

### Offline quest database

`bridge/data/forever-quests.json` (about 4,400 quests, 450 KB) is converted from the [AllTheThings](https://github.com/ATTWoWAddon/AllTheThings) Forever data (MIT) by `tools/build-quest-db.js` and ships with the companion, so it works offline. `tools/att-parser.js` reads ATT's Lua data files without running them: it applies ATT's `-- #if` preprocessor for the Forever target (tags `FOREVER`, `ANYCLASSIC`; `BEFORE`/`AFTER` against patch 1.60.1), evaluates timelines at 1.60.1, resolves `MAP.*` constants and keeps only map ids in the Forever client's `UiMap` table, and takes quest and NPC names from ATT's trailing comments. Quests from ATT's unreviewed `zzOLD` folder fill gaps and are marked unverified. See [bridge/data/README.md](../bridge/data/README.md) for the record format and attribution.

`bridge/questdb.js` answers from it with the player's game state: level, race, class and faction from the `char` section, map and position from `loc`, active quests from `quests`, and completed quests from `done.*`. A quest is offered when its giver is on the player's map, it is not completed (unless repeatable) or already in the log, faction/race/class/level allow it, and its prerequisites are done (when the completed list is unknown, prerequisites are listed instead of checked). Results are sorted by straight-line map distance with an eight-point direction. Holiday quests are left out.

## Fish Audio

Spoken answers stream by default (`bridge/speech.js`):

```text
guide model (Responses API, stream: true)
  -> response.output_text.delta events -> "speech" field of the JSON answer, as it arrives
  -> sentence splitter -> Fish wss://api.fish.audio/v1/tts/live (MessagePack: start, text + flush per sentence, stop)
  -> audio events (16-bit PCM, 44.1 kHz) -> bridge -> desktop main -> renderer
  -> Web Audio buffers scheduled back to back -> gain -> limiter -> speakers
```

The answer schema puts `basis` before `speech`, so the Classic/general label is spoken first. A round whose output adds a function call or web search speaks nothing and tells the speaker a lookup started; if no answer speech follows within `fish.fillerDelayMs`, a short filler line ("Let me check that.") goes out on the same Fish stream. The text answer goes to the game as soon as the model finishes; audio that is still playing finishes on its own. Gemini and local presets are not streamed, but their answer still goes to Fish sentence by sentence.

If the socket fails before any audio arrived, the worker falls back to the one-shot path: it posts the text to Fish `/v1/tts`, requests a mono WAV, and sends the file path to the parent, which reads and deletes it and plays it in the renderer. `fish.stream: false` always uses that path. A Fish failure never discards the text answer.

Deepgram Flux's `EagerEndOfTurn`/`TurnResumed` events (starting the model speculatively before the turn is final) are not used yet.

## Announcements and quest narration

The add-on reports a few moments in `a` records: a quest in the log becomes ready to turn in (`ReadyForTurnIn`, with `GetNextWaypointText`), `PLAYER_LEVEL_UP` (with the names of `C_SpellBook.GetCurrentLevelSpells`), `ZONE_CHANGED_NEW_AREA` to a new zone, free bag slots dropping to 2 or fewer, the most worn item dropping to 20 % durability or less, and `QUEST_ACCEPTED` (title, story text and objectives from the quest log). The first quest-log look after login and the login zone only set a baseline; bags and durability warn once until they recover. Nothing is sent while `InCombatLockdown()` or `UnitAffectingCombat("player")`: moments wait for `PLAYER_REGEN_ENABLED` and are dropped after a minute.

`bridge/announce.js` speaks a moment only when its kind is switched on in `announce` (all off by default; `accept` uses `narrate`, `repair` uses `bags`). It builds one or two sentences without a model call, from the moment, the game state and the offline quest database (the quest giver when the client gives no next step; the zone briefing is `questdb.zoneSummary`). Each kind has a minimum interval, at most four wait in a queue, anything older than a minute is dropped, and announcements wait while the guide is answering or speaking. They play through the same Fish streaming path as answers.

Switches live in `bridge/config.json`. `/wow-claude announce <kind> on|off` and `/wow-claude narrate on|off` send an `ann=` flag that the bridge applies and the desktop process saves; every slot file carries the current switches back (`announce = { quest = true, ... }`), so the add-on stops sending moments nobody will speak. "Read me this quest" is answered from the `quest` section directly, without a model call.

## Inbound game protocol

WoW can load an add-on's Lua files only once per UI session. Setup therefore pre-creates `WoWClaude_S001` through `WoWClaude_S200`. The bridge writes the latest reply table to every unused slot; the add-on loads the next slot and applies the record.

A final voice record can include `transcript` and `waypoint`. The add-on replaces the temporary `[Voice] Listening...` user message with the transcript, adds the guide answer, and renders a waypoint button when present.

Small valid/empty WAV files provide inexpensive acknowledgement, completion, action, and presence signals. Timed slot polling and the SavedVariables `/reload` route remain fallbacks.

## State and failure behavior

- Only one microphone/Flux session exists at once.
- One pending request per chat is retained from the upstream add-on model.
- The capture timeout is 30 seconds by default.
- Empty speech does not call the brain or Fish.
- HTTP calls use abort timeouts.
- Chat history and deduplication survive restarts in local JSON files.
- Provider secrets never enter the pixel stream, slot Lua, or WoW SavedVariables.
- No component automates character movement or combat actions.

## Compatibility names

The add-on folder, SavedVariables table, Lua global, slot prefixes, and much of the tested protocol retain `WoWClaude` names. They are implementation identifiers inherited from the upstream MIT project, not a Claude dependency. Player-facing labels and the provider pipeline use WoW Voice Guide.
