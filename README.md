# WoW Voice Guide

Press **Talk** once inside World of Warcraft: Forever, speak naturally, stop speaking, and hear the answer in a selected Fish Audio voice. The transcript and answer also appear in the in-game window.

This is an MIT-licensed fork of [chelinho139/wow-claude](https://github.com/chelinho139/wow-claude). It retains the original project's game-to-desktop transport and replaces the Claude Code agent with a voice guide powered by your own Deepgram, model-provider, and Fish Audio accounts.

## What runs

There are only two things the player runs:

1. The **WoW Voice Guide add-on** inside the game.
2. One **WoW Voice Guide desktop companion** left open while playing.

The companion talks to three APIs; Deepgram, the brain provider, and Fish Audio are services, not additional programs:

```text
in-game Talk button
  -> desktop microphone
  -> Deepgram Flux transcript + automatic end-of-turn
  -> selected guide model
  -> Fish Audio character voice
  -> speakers + answer in the WoW window
```

WoW add-ons cannot use the network or microphone. That sandbox is why the companion is necessary. Nothing injects into the game, reads game memory, moves the character, or generates player input.

## Brain recommendation

The shipped default is **GPT-6 Luna with reasoning disabled**. It is the best starting point for this particular job: short, focused answers, structured output, low model cost, and no unnecessary deliberation before speech.

The settings screen also includes:

- **GPT-4.1 Mini** — a low-latency fallback with strong instruction following.
- **Gemma 4 26B A4B** through the Gemini API — the Gemma preset I would try first; the mixture-of-experts model is the better latency/quality shape for this use.
- **Gemma 4 31B** through the Gemini API — dense and potentially heavier/slower.
- **Local / other OpenAI-compatible** — LM Studio, llama.cpp, vLLM, or another hosted Chat Completions endpoint.

The model is the conversational brain, not the source of truth. The add-on grounds it with character, location, coordinates, selected/super-tracked quest, and current objectives where Forever exposes those APIs. Exact destination waypoints are accepted only as structured data and still require the player to click **Set waypoint**. For a production-quality quest oracle, the next layer should be a licensed/version-matched quest database or retrieval service; model memory alone cannot guarantee exact Forever beta coordinates.

## Requirements

- Windows and World of Warcraft: Forever, windowed or borderless
- Node.js 22.12 or newer
- API keys for Deepgram and Fish Audio
- One brain-provider key: OpenAI or Google, unless using a local OpenAI-compatible server
- A Fish Audio voice model ID if you want to change the bundled example voice

The example configuration preselects the public [Warcraft 3 Peon voice on Fish Audio](https://fish.audio/m/06c4b6c98f8a451cad28734427faaa9d/). It is a voice choice, not an API credential. You can replace its `reference_id` in the companion. Community voices can be renamed, removed, or subject to usage restrictions; check the voice page and Fish terms before distributing generated audio.

## Install from source

```powershell
git clone https://github.com/Griffden/wow-voice-guide.git
cd wow-voice-guide
npm install
node setup.js --wow "C:\path\to\World of Warcraft\_classic_beta_"
npm start
```

`setup.js` locates the WoW account, copies the add-on, writes `bridge/config.json`, and creates the pre-registered reply slots. Fully quit and relaunch WoW after setup; `/reload` is not sufficient for discovering newly created add-ons.

In the companion settings:

1. Paste the Deepgram API key.
2. Choose a brain preset and paste its key, or configure a local endpoint.
3. Paste the Fish Audio API key. The Peon voice is preselected; replace its model ID if you want another voice.
4. Save. The bridge restarts automatically.

In game, enable **WoW Voice Guide**, type `/voice-guide`, then press **Talk**. You can also bind a key in the game's Key Bindings menu or use `/wow-claude bind F8` (replace `F8` with your preferred key); pressing it starts listening without opening the window. The standalone `/voice` command starts listening immediately. The companion's **Finish now** control forces the current turn to end; **Cancel listening** abandons it. The in-game **Voice volume** slider ranges from 0–200%; `/wow-claude volume 150` sets the same value directly. Values above 100% use companion-side amplification with clipping protection.

Typed chat remains available as a fallback. Fish only speaks voice-originated questions by default; set `fish.speakTyped` to `true` in `bridge/config.json` to speak typed answers too.

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

The suite parses the real Lua, executes the add-on in a Lua VM, round-trips the pixel codec under noise, and tests voice flags, transcript replacement, PCM conversion, structured answers, secret redaction, and waypoint serialization. A real-service smoke test still requires personal provider keys and a running Forever client.

## Current delivery status

This repository is a functioning source prototype and includes Electron packaging configuration. The provider-independent flow is implemented and tested. A signed public installer, store distribution, and hosted proxy for hiding shared production credentials are release work, not prerequisites for running the source build.

Primary service references: [Deepgram Flux](https://developers.deepgram.com/docs/flux/quickstart), [Fish Audio TTS](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-4.1 Mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), and [Gemma 4 on the Gemini API](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api).
