# Configuration

Run `node setup.js` first. It creates `bridge/config.json` from `bridge/config.example.json` and fills in the machine-specific WoW paths. The desktop settings screen edits only the provider sections and restarts the worker after saving.

## Secrets

Keys can be stored in the local config for development. Environment variables take precedence:

| Variable | Used for |
|---|---|
| `DEEPGRAM_API_KEY` | Flux transcription |
| `FISH_API_KEY` | Fish Audio speech |
| `WOWVOICE_LLM_API_KEY` | OpenAI or another OpenAI-compatible endpoint |
| `GEMINI_API_KEY` | Hosted Gemma 4 preset |

`bridge/config.json` is gitignored. Provider errors and companion logs run through secret redaction.

## Deepgram Flux

| Field | Default | Meaning |
|---|---:|---|
| `deepgram.model` | `flux-general-en` | Flux English model; use `flux-general-multi` for multilingual input |
| `deepgram.eotThreshold` | `0.7` | Natural end-of-turn confidence; valid range 0.5–1.0 |
| `deepgram.eotTimeoutMs` | `5000` | Silence backstop before an `EndOfTurn` |
| `deepgram.captureTimeoutMs` | `30000` | Local maximum for one listening request |
| `deepgram.keyterms` | Warcraft terms | Plain terms that improve recognition |

The app streams raw mono signed 16-bit PCM at 16 kHz in roughly 80–85 ms browser audio chunks. It waits for Flux's final `EndOfTurn`. The companion's **Finish now** button sends `ForceEndTurn`.

## Brain

`llm.provider` is either `openai-compatible` or `gemini`.

### OpenAI-compatible

| Field | Default | Meaning |
|---|---|---|
| `llm.endpoint` | `https://api.openai.com/v1/chat/completions` | Chat Completions URL |
| `llm.model` | `gpt-6-luna` | Model name sent to the provider |
| `llm.reasoningEffort` | `none` | Keeps Luna focused and avoids reasoning latency |
| `llm.temperature` | `0.2` | Low-variance guide answers |
| `llm.maxTokens` | `500` | Reply ceiling |
| `llm.responseFormat` | enabled | Requests a JSON object; set `false` for servers that reject it |
| `llm.timeoutMs` | `45000` | HTTP timeout |

The local preset uses `http://127.0.0.1:1234/v1/chat/completions`, which matches LM Studio's common default. Change the URL/model for llama.cpp, vLLM, Ollama compatibility layers, or another host.

### Player guide lookups

Every question goes through two steps:

1. **Quest-log lookup.** If the question names a quest in your log (matched loosely, since speech transcripts rarely match a title exactly), or asks "where do I go?" or "how do I finish this quest?" about the selected or tracked quest, the companion fetches that quest's objectives, turn-in, and quest text from the Wowhead WoW: Forever database and gives them to the model. This works with every brain preset.
   If the question asks what to do or where to find quests ("what should I do?", "any quests around here?"), the quests you can pick up on your map, nearest giver first, are added from the offline Forever quest database (`bridge/data/forever-quests.json`). This also works with every preset and needs no network.
2. **Tool-using guide** (OpenAI preset and key). The model answers through OpenAI's Responses API and decides which lookups it needs: `quests_near_me` and `quest_info` (the offline quest database: quests to pick up on a map, and one quest's givers with coordinates and prerequisites), `wowhead_search` (find Forever quests, NPCs, items, spells, zones by name), `wowhead_lookup` (one entry by id, including NPC map coordinates), and live `web_search`. Small talk and questions your game context already answers use no tools. The companion status line shows each lookup as it happens.

Answers are labeled instead of withheld. The model reports what an answer rests on: your game context, Forever data, Classic information, or general knowledge. Classic and general answers start with a short spoken caveat, and a claimed Forever answer with nothing looked up is treated as general knowledge. Sources appear in game and as companion buttons. A waypoint button appears only for coordinates that came from a lookup or a cited page; when the answer names one looked-up NPC that has coordinates, the companion sets the waypoint up itself.

Wowhead has no official API. The companion uses the JSON endpoints behind Wowhead's own tooltips and search (`nether.wowhead.com/forever/tooltip/...` and `wowhead.com/forever/search/suggestions-template`) and caches results for six hours. Its beta data is incomplete (some NPCs have no location yet). `bridge/zones.json` maps Wowhead zone ids to in-game map ids and was generated from the Forever 1.60.1.70009 client tables on wago.tools.

| Field | Default | Meaning |
|---|---|---|
| `playerGuide` | enabled | Set to `false` to turn off all lookups (Wowhead, web, and the offline quest database); questions then go straight to the brain preset |
| `playerGuide.model` | `gpt-6-luna` | Responses API model for the tool-using guide |
| `playerGuide.reasoningEffort` | model default | Optional Responses API reasoning effort |
| `playerGuide.maxRounds` | `4` | Model calls per question; the last one cannot call tools, so an answer always arrives |
| `playerGuide.stream` | `true` | Stream the Responses API reply so spoken answers start on the first sentence (only when the answer is spoken and `fish.stream` is on) |
| `playerGuide.timeoutMs` | `60000` | Deadline for the whole answer, including lookups |

The add-on sends every quest in your log with its objective progress and turn-in state, and the full text, next step and turn-in text for the selected or tracked quest. It does not read the rendered screen. If several quests are open and none is selected or tracked, name or shift-click the quest when asking which one you mean.

### Hosted Gemma 4

Set `provider` to `gemini` and choose `gemma-4-26b-a4b-it` or `gemma-4-31b-it`. `llm.thinkingLevel` defaults to `minimal`. The endpoint is the native Gemini `generateContent` API, not an OpenAI compatibility shim.

## Fish Audio

| Field | Default | Meaning |
|---|---|---|
| `fish.voiceId` | `06c4b6c98f8a451cad28734427faaa9d` | Selected Fish voice model `_id`; use the companion preset menu or paste a custom ID |
| `fish.model` | `s2.1-pro-free` | Use `s2.1-pro` for the paid production model |
| `fish.latency` | `balanced` | `normal`, `balanced`, or `low` |
| `fish.speed` | `1` | Voice speed |
| `fish.volume` | `0` | Gain adjustment |
| `fish.speakTyped` | `false` | Also synthesize typed questions' answers |
| `fish.stream` | `true` | Stream speech over Fish's WebSocket (`wss://api.fish.audio/v1/tts/live`): synthesis starts on the first sentence and PCM chunks play as they arrive. `false` uses the one-shot `POST /v1/tts` WAV after the whole answer. Companion Settings: **Stream speech** |
| `fish.filler` | `true` | While a lookup (Wowhead, web search, quest database tool) keeps the answer waiting, say a short filler line. Companion Settings: **Say a short filler line** |
| `fish.fillerDelayMs` | `1200` | How long a lookup must run, with no answer speech yet, before the filler is said |
| `fish.fillers` | built in | Filler lines to pick from, e.g. `["Let me check that."]` |
| `fish.timeoutMs` | `60000` | Synthesis timeout |

The companion's built-in voice choices are Peon (`06c4b6c98f8a451cad28734427faaa9d`), Furbolg (`fa4d72bfeee64c029970e09aeb67c43e`), and Knight (`b31185cef9d54e908c58dfe901e9598b`). Peon and Knight select their matching talking portraits in the minimized in-game bar. Choosing a voice fills the same editable `fish.voiceId` field; an existing custom ID stays intact and appears as **Custom model ID**. Peon remains the fresh-install default. Public model visibility does not establish permission to publish generated audio or imply an endorsement.

Streamed output is 44.1 kHz mono 16-bit PCM; the one-shot path returns 44.1 kHz mono WAV. If the stream fails before any audio played, the answer is synthesized through the one-shot path instead, so a socket problem costs time but not the reply. Check the model page and Fish account terms before distribution.

### Latency

With the OpenAI preset and both streaming options on (defaults), the guide model's answer is streamed too (`playerGuide.stream`): the answer's JSON puts `basis` first, its spoken label (if any) and the first sentence of `speech` go to Fish while the model is still writing, and the text answer reaches the game when the model finishes. Gemini and local presets are not streamed, but their answer still reaches Fish sentence by sentence. The bridge log records `first audio N ms after the question` for every spoken answer.

### Spoken announcements

Short spoken notes in the selected Fish voice, each switched on separately and **off by default**. The same switches are in companion Settings (**Spoken announcements**) and in game (`/wow-claude announce <kind> on|off`, `/wow-claude narrate on|off`; `/wow-claude announce` alone lists them). They are information only: nothing presses keys, targets, moves or accepts anything for you.

| Field | Default | Says |
|---|---|---|
| `announce.quest` | `false` | "Wolves Across the Border is ready to turn in. Return to Marshal Dughan." (the client's next step, else the quest giver and coordinates from the quest database) |
| `announce.level` | `false` | "Level 16! New at your class trainer: Shield Block and Revenge." |
| `announce.zone` | `false` | "Welcome to Westfall. There are 12 quests you can pick up in Westfall. Nearest: ..." |
| `announce.bags` | `false` | "Your bags are almost full: 1 free slot left." at 2 or fewer free slots; a repair warning when an item drops to 20 % durability |
| `announce.narrate` | `false` | Reads a newly accepted quest's title, text and objectives aloud |

Never during combat: the add-on holds moments until combat ends and drops them after a minute. Zone briefings are spoken at most every 90 seconds, bag and repair warnings at most every 5 minutes, and announcements wait while the guide is answering. Saying "read me this quest" reads the selected or tracked quest whether or not narration is on.

### Playback volume

The add-on saves `voiceVolume` per WoW account and synchronizes it to the companion at login and whenever the in-game slider changes. The range is 0–200%, with 125% as the default. Values above 100% are applied through Web Audio gain followed by a limiter. The companion mirrors the current value to `audio.volumePercent` in `bridge/config.json` so it survives a companion-only restart.

## Game transport

The setup script normally owns these values:

| Field | Default | Meaning |
|---|---:|---|
| `addonDir` | detected | WoW `Interface\AddOns` folder |
| `savedVariablesFile` | detected | Reload-mode fallback outbox |
| `inboxFile` | detected | Main add-on fallback inbox |
| `capture.processName` | detected | Forever executable name without `.exe` |
| `capture.cellPx` | `4` | Pixel-strip cell size |
| `capture.cellsPerRow` | `200` | Pixel-strip width |
| `capture.maxRows` | `48` | Maximum captured rows |
| `capture.intervalMs` | `250` | Screen capture interval |
| `slots` | `200` | Load-on-demand response slots per UI session |

`gameContext: false` disables sending character/location/quest context to the brain. `gameContextMaxChars` (default `3500`) caps the game context assembled for each question from the add-on's game state sections; the sections the question is about are kept first (see [ARCHITECTURE.md](ARCHITECTURE.md#game-state-sections)). In game, `/wow-claude context off` clears every section the companion holds and stops sending them. Internal names still say `WoWClaude` because changing them would break upstream transport compatibility and existing SavedVariables.

## Runtime files

| File | Purpose |
|---|---|
| `bridge/config.json` | Local paths and provider configuration |
| `bridge/state.json` | Deduplication, heartbeat, and the latest game state sections |
| `bridge/transcripts.json` | Short local per-chat history and reset recovery |
| `bridge/bridge.log` | Redacted worker log |
| `bridge/audio/` | Ephemeral Fish WAV files, deleted after the companion reads them |
