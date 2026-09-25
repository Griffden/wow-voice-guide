# WoW Voice Guide

![WoW Voice Guide desktop companion](demo/voice-guide-companion.png)

**A voice-first player guide for World of Warcraft: Forever.** Press **Talk** (or your bound key) once, ask a question, stop speaking, and hear the answer in a selected Fish Audio voice. Your transcript and the answer also appear in game. You do not need to say “Forever” in every question: the guide treats WoW questions as being about **WoW: Forever** unless you explicitly ask about another version.

This is an MIT-licensed fork of [chelinho139/wow-claude](https://github.com/chelinho139/wow-claude). It retains the original project's game-to-desktop transport and replaces the Claude Code agent with a voice guide powered by your own Deepgram, model-provider, and Fish Audio accounts.

## What it can do today

| Capability | What you can do |
|---|---|
| Hands-free questions | Press the in-game **Talk** button, `/voice`, or a keybind; Deepgram Flux detects when you finish talking. The companion's **Finish now** and **Cancel listening** buttons are fallbacks. |
| Spoken character voices | Hear replies through Fish Audio, streamed: speech starts on the answer's first sentence while the rest is still being written, and a short "Let me check that." covers a slow lookup. Both can be turned off in companion Settings. Pick Peon, Furbolg, or Knight in the companion, or paste any other Fish Voice Library model ID. Set voice volume from the in-game slider or `/wow-claude volume 0-200`. |
| Talking portrait | Minimize the in-game window to its top bar. The Peon voice shows the animated orc portrait; the Warcraft 3 Knight voice shows the animated Knight portrait based on the supplied image. Other voices show a neutral guide icon. The portraits move during spoken replies and return to their resting frame afterward. If the client cannot read the live audio signal, the add-on estimates speaking time from the reply. Click the bar to reopen the full window. |
| Character-aware answers | Ask about your character, level, zone, map position, money, XP and rested XP, hearthstone, talents (read through the Forever client's `C_Traits` talent API), professions, equipped gear and item levels, low durability, bag space, and the flight paths you know (read whenever you open a flight map). The add-on pushes each of these as it changes, so the guide always has the latest state. View or disable what is shared with `/wow-claude context`. |
| Quest help | The add-on sends every quest in your log with its objective progress and whether it is ready to turn in, plus the full text, next step and turn-in text of the selected or tracked quest, and the quests you have completed. Ask where to go, what an objective means, or what to do next. |
| NPC and target awareness | When you talk to an NPC, the guide sees what they said and which quests they offer or accept (with quest IDs), so "what is he asking me to do?" works. It also knows your current target's name, level, elite/rare status, creature type and whether it is hostile. It never reads health, auras or cooldowns. |
| Forever game data | Quests in your log that you mention (or your selected quest, when you ask "where do I go?") are looked up in the Wowhead WoW: Forever database before the guide answers: objectives, turn-in NPC, and quest text. With an OpenAI key and preset, the guide can also search that database itself (quests, NPCs with map coordinates, items, spells, zones) and the live web, choosing which lookups a question needs. Answers show their sources in game and as clickable buttons in the companion. |
| Quests near you | Ask "what should I do?" or "any quests around here?" and the guide lists the quests you can pick up on your map, nearest quest giver first, from an offline WoW: Forever quest database converted from [AllTheThings](https://github.com/ATTWoWAddon/AllTheThings) (MIT). It filters by level, faction, race, class, the quests you have completed or already carry, and prerequisites. "Who gives X?" returns the giver and coordinates, which can become a waypoint. Works with every brain preset, offline. |
| Spoken announcements (opt-in) | Switch on any of: "quest objectives complete" (with where to turn in), level up (with the new spells at your trainer), a one-sentence briefing when you enter a new zone, bags nearly full or gear about to break, and reading newly accepted quests aloud in your Fish voice. All are off by default, rate limited, never spoken during combat, and informational only. Say "read me this quest" any time to hear the selected quest. |
| Labeled answers | The guide answers instead of refusing and says what an answer rests on: Forever data needs no caveat, while answers based on Classic information or general WoW knowledge start with a short spoken label. |
| Item, spell, and quest details | Focus the guide input and shift-click an in-game link; its name and tooltip are attached to your question. This is the precise way to ask “What is this?” about an item or quest. |
| Optional waypoints | When an answer contains a valid, grounded map ID and coordinates, a **Set waypoint** button appears. You choose whether to set it; the guide does not move your character. |
| In-game chat and follow-ups | Type in the window or use `/ai <question>`; `/r` replies to the guide when it was the last messenger. Replies can be echoed into game chat, and multiple conversations, transcript recovery, copyable answers, and a minimizable status bar are retained from the original add-on. |

Try:

- “Where do I go for my tracked quest?” or “Where do I find the Mirror Lake water sample?”
- “What quests can I pick up around here?”
- While talking to an NPC: “Which of these quests should I take?”
- “Where is Cerellean Whiteclaw?” (answers with coordinates and a **Set waypoint** button)
- “What talents do I have?” or “Read me this quest.”

For a specific item or quest, shift-click its link into the guide input before asking.

The guide does **not** see the whole game screen, read every open panel, or control movement/combat. Its offline quest database knows quest givers, not every turn-in NPC, and more than half its quests come from AllTheThings data not yet reviewed for Forever; the guide says when an answer rests on those. Wowhead's public Forever data, which it also reads, is incomplete during the beta (some NPCs have no location yet). The desktop companion captures only the add-on's encoded pixel strip to receive messages; screen understanding is not implemented.

## What runs

There are only two things the player runs:

1. The **WoW Voice Guide add-on** inside the game.
2. One **WoW Voice Guide desktop companion** left open while playing.

The companion talks to three paid APIs (Deepgram, the brain provider, and Fish Audio) plus Wowhead's public Forever data. These are services, not additional programs:

```text
add-on pushes live game state (character, quests, NPC dialog, target, gear, flight paths)
in-game Talk button
  -> desktop microphone
  -> Deepgram Flux transcript + automatic end-of-turn
  -> guide model, with lookups it chooses:
       offline Forever quest database (quests near you, quest givers)
       Wowhead Forever (quests, NPCs with coordinates, items, spells)
       live web search
  -> Fish Audio character voice, streamed as the answer is written
  -> speakers + answer (with sources and optional waypoint) in the WoW window
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how each step works.

WoW add-ons cannot use the network or microphone. That sandbox is why the companion is necessary. Nothing injects into the game, reads game memory, moves the character, or generates player input.

## Models and WoW: Forever accuracy

The shipped default brain preset is **GPT-6 Luna with reasoning disabled**. Other presets are available in companion Settings:

- **GPT-4.1 Mini** — a low-latency fallback with strong instruction following.
- **Gemma 4 26B A4B** through the Gemini API — the Gemma preset I would try first; the mixture-of-experts model is the better latency/quality shape for this use.
- **Gemma 4 31B** through the Gemini API — dense and potentially heavier/slower.
- **Local / other OpenAI-compatible** — LM Studio, llama.cpp, vLLM, or another hosted Chat Completions endpoint.

Both the normal-answer and web-lookup prompts default to **World of Warcraft: Forever**, even when you just say “WoW.” The guide looks things up in the Wowhead Forever database first, then the web, then falls back to Classic/Vanilla information or general knowledge, and labels those answers because the beta can change routes, NPCs, and objectives. Your current in-game quest ID and objectives take priority when they differ. It does not silently import Retail or expansion guidance. Waypoints come only from looked-up or cited coordinates.

## Requirements

- Windows and World of Warcraft: Forever, windowed or borderless
- Node.js 22.12 or newer
- API keys for Deepgram and Fish Audio
- One brain-provider key: OpenAI or Google, unless using a local OpenAI-compatible server
- A Fish Audio voice model ID only if you want a voice outside the built-in choices

The example configuration preselects [Warcraft 3 Peon](https://fish.audio/m/06c4b6c98f8a451cad28734427faaa9d/). The companion also offers [Furbolg (Warcraft 3 ENG)](https://fish.audio/m/fa4d72bfeee64c029970e09aeb67c43e/) and [Warcraft 3 Knight](https://fish.audio/m/b31185cef9d54e908c58dfe901e9598b/). These are Fish model IDs, not API credentials or official endorsements. Check your rights to use a voice before publishing generated audio; community models can be renamed or removed.

### Talking head examples

The minimized in-game bar pairs the Peon voice with the orc portrait and the Knight voice with the Knight portrait. Each sheet shows the resting frame followed by three speaking frames; the add-on cycles the speaking frames while the agent talks. Furbolg and custom voices show a neutral guide icon.

| Warcraft 3 Peon | Warcraft 3 Knight |
|---|---|
| ![Peon talking head: resting frame and three speaking frames](concepts/talking-head-final-preview.png) | ![Knight talking head: resting frame and three speaking frames](concepts/knight-final-preview.png) |

## Install from source (Windows)

You need the Forever beta client, Node.js 22.12+, a Deepgram key for transcription, a Fish Audio key for speech, and a brain-provider key (OpenAI or Google) unless you run a local compatible model. **The guide's own database and web lookups currently require an OpenAI preset and key**; Google/local presets still get the automatic lookup of quests you mention. Each provider uses your own account and may charge for usage. The example Fish voice ID is public and is not an API key.

1. Fully close WoW, open PowerShell, and clone/install the project:

   ```powershell
   git clone https://github.com/Griffden/wow-voice-guide.git
   cd wow-voice-guide
   npm install
   node setup.js
   ```

   If setup cannot find your beta client, run `node setup.js --wow "C:\path\to\World of Warcraft\_classic_beta_"`. If it finds the wrong WoW account, pass `--account NAME`. Setup copies the add-on, creates your local `bridge/config.json`, and pre-creates the numbered reply slots. Re-running setup keeps your existing keys/config.

2. Relaunch WoW in **windowed or borderless** mode. At character select, enable **WoW Voice Guide** and leave the numbered `WoWClaude_S###` slot add-ons enabled. A full client restart is needed to discover newly created add-on folders; `/reload` alone is not enough.

3. Start the desktop companion from the project folder and leave it running while you play:

   ```powershell
   npm start
   ```

4. In companion **Settings**, enter your Deepgram API key, select a brain preset and enter that provider's key (OpenAI if you want web lookup), and enter your Fish Audio API key. Choose one of the three built-in Fish voices or paste a custom model ID. Peon remains the initial choice. Click **Save and restart bridge**. Windows may ask for microphone permission on your first Talk request.

5. In game, use `/voice-guide` to open the window and press **Talk**. Speak, then pause; the answer should appear in game and play through Fish. Bind a key in WoW's Key Bindings menu or run `/wow-claude bind F8` (replace `F8` with your preferred key) to ask without reopening the window. `/voice` also starts listening immediately.

For first-run problems, account selection, microphone permissions, and transport diagnostics, see the [detailed Windows guide](docs/INSTALL-WINDOWS.md). Do not commit `bridge/config.json`; it contains your keys and is gitignored.

### Updating an existing install

Fully close WoW, then from the project folder:

```powershell
git pull
npm install
node setup.js
```

Relaunch WoW (new add-on files are only discovered at launch) and restart the companion. Setup keeps your keys and settings.

Typed chat remains available as a fallback. Fish only speaks voice-originated questions by default; set `fish.speakTyped` to `true` in `bridge/config.json` to speak typed answers too. The in-game **Voice volume** slider ranges from 0–200%; values above 100% use companion-side amplification with clipping protection.

### Useful in-game commands

| Command | Use |
|---|---|
| `/voice` | Start one voice question without opening the guide window. |
| `/voice-guide` | Show or hide the guide window. |
| `/ai <question>` | Send a typed question from the regular game chat box. |
| `/r <reply>` | Reply to the guide when it was the last messenger; otherwise WoW's normal whisper reply. |
| `/wow-claude bind F8` | Bind the Talk action to a key; substitute your preferred key. |
| `/wow-claude context` | Show exactly what game context is shared; append `on` or `off` to change it. |
| `/wow-claude volume 150` | Set spoken-reply volume (0–200). |
| `/wow-claude announce zone on` | Switch a spoken announcement on or off: `quest`, `level`, `zone`, `bags`, or `all`. No argument lists them. Also in companion Settings. |
| `/wow-claude narrate on` | Read newly accepted quests aloud in the guide voice. |
| `/wow-claude size reset` | Restore the default window size and center it (or right-click the window's resize grip). |
| `/wow-claude new`, `chat`, `clear`, `copy` | Manage conversations and copy the last answer. |
| `/wow-claude diag`, `slots`, `reload` | Diagnose transport or free used reply slots. |

`/wow-claude help` lists every command. The `WoWClaude` name is retained internally for compatibility with the original transport.

## Important configuration

Secrets may be entered in the companion or supplied as environment variables, which override config:

```text
DEEPGRAM_API_KEY
FISH_API_KEY
WOWVOICE_LLM_API_KEY
GEMINI_API_KEY
```

The default provider block is:

```json
{
  "llm": {
    "provider": "openai-compatible",
    "endpoint": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-6-luna",
    "reasoningEffort": "none"
  }
}
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for every field and [PLAN.md](PLAN.md) for the researched architecture and delivery decisions.

## How the WoW transport works

The upstream transport solves the add-on sandbox without process injection:

- **Out of WoW:** the add-on draws a checksummed strip of tiny colored cells. A PowerShell helper captures that screen region and decodes the request.
- **Back into WoW:** the bridge writes the answer into one of 200 pre-created load-on-demand slot add-ons. WoW loads a fresh slot and reads the Lua table.
- **Signals:** tiny WAV files provide cheap acknowledgement and readiness signals. Slot polling remains the fallback.

Internal `WoWClaude` folder/global names and legacy `/wow-claude` commands remain for protocol and SavedVariables compatibility. The player-facing product is WoW Voice Guide.

## Verification

```powershell
npm test
```

The suite parses the real Lua and runs the add-on in a Lua VM against a stub of the WoW API. It round-trips the pixel codec under noise and covers:

- the game-state sections the add-on pushes, and how the companion merges them
- the quest database's availability filters
- the guide's lookup loop and answer labels
- streamed speech over a mocked Fish WebSocket
- announcement rate limits and combat hold
- voice flags, structured answers, secret redaction, and waypoints

No real provider is called. A real-service smoke test still needs personal provider keys and a running Forever client.

To rebuild the offline quest database from the latest AllTheThings data, run `npm run build:quests`.

## Data sources and credits

- **Offline quest database:** converted from the [AllTheThings](https://github.com/ATTWoWAddon/AllTheThings) WoW: Forever data (MIT license; notice kept in [bridge/data/README.md](bridge/data/README.md)).
- **Quest, NPC, item, and spell lookups:** Wowhead's public WoW: Forever tooltip and search data. Wowhead has no official API, so results are cached and requests kept small.
- **Zone-to-map table:** generated from the Forever client's map tables on [wago.tools](https://wago.tools).
- **Forever add-on API reference:** checked against the capture in [forever-addon-kit](https://github.com/Thunderz96/forever-addon-kit).

## Current delivery status

This repository is a working source prototype, tested in game on the WoW: Forever beta (1.60.1), and includes Electron packaging configuration. A signed public installer, store distribution, and a hosted proxy for hiding shared production credentials are release work, not prerequisites for running the source build.

Primary service references: [Deepgram Flux](https://developers.deepgram.com/docs/flux/quickstart), [Fish Audio TTS](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech) and [streaming TTS](https://docs.fish.audio/api-reference/endpoint/websocket/tts-live), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-4.1 Mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), and [Gemma 4 on the Gemini API](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api).
