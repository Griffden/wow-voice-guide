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

### Player guide web lookup

When a question asks for quest help, location, or a web guide, the companion uses OpenAI's Responses API web search with the existing OpenAI key. It searches the provider's index/cache, not live Wowhead pages. The companion shows clickable cited sources; the in-game answer includes their URLs and a direct Wowhead Forever quest-page link when the focused quest has an ID. That link is **not** evidence the page was searched. Ordinary conversation does not trigger search. Searches may add usage charges and latency.

All WoW-related questions default to **World of Warcraft: Forever** in both ordinary model answers and web lookup, unless the player explicitly asks about another edition or to compare editions. The guide is instructed to prefer current in-game quest IDs, objectives, and linked tooltips and to avoid importing Retail or Classic routes. The bridge also withholds a searched route if the cited source titles/URLs do not clearly match Forever and the subject. This is a conservative heuristic, not proof that an indexed page is correct for the new beta; unsupported steps should still be treated as unverified.

This first version requires the OpenAI brain endpoint and key; other brain presets still answer normal questions but quest web lookup will explain the missing OpenAI configuration. Set `"playerGuide": false` in local config to disable automatic search. `playerGuide.model` defaults to `gpt-6-luna`; `playerGuide.timeoutMs` defaults to `60000`.

The add-on sends a compact list of up to 25 visible quests plus objectives and instructions for the selected or tracked quest. It does not read the rendered screen. If several quests are open and none is selected or tracked, name or shift-click the quest when asking which one you mean.

### Hosted Gemma 4

Set `provider` to `gemini` and choose `gemma-4-26b-a4b-it` or `gemma-4-31b-it`. `llm.thinkingLevel` defaults to `minimal`. The endpoint is the native Gemini `generateContent` API, not an OpenAI compatibility shim.

## Fish Audio

| Field | Default | Meaning |
|---|---|---|
| `fish.voiceId` | `06c4b6c98f8a451cad28734427faaa9d` | Example Warcraft 3 Peon voice on Fish; replace with another permitted public/owned voice model `_id` |
| `fish.model` | `s2.1-pro-free` | Use `s2.1-pro` for the paid production model |
| `fish.latency` | `balanced` | `normal`, `balanced`, or `low` |
| `fish.speed` | `1` | Voice speed |
| `fish.volume` | `0` | Gain adjustment |
| `fish.speakTyped` | `false` | Also synthesize typed questions' answers |
| `fish.timeoutMs` | `60000` | Synthesis timeout |

Output is 44.1 kHz mono WAV. A voice model may be public without being licensed for every use; check the model page and Fish account terms before distribution.

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

`gameContext: false` disables sending character/location/quest context to the brain. Internal names still say `WoWClaude` because changing them would break upstream transport compatibility and existing SavedVariables.

## Runtime files

| File | Purpose |
|---|---|
| `bridge/config.json` | Local paths and provider configuration |
| `bridge/state.json` | Deduplication, heartbeat, and last game context |
| `bridge/transcripts.json` | Short local per-chat history and reset recovery |
| `bridge/bridge.log` | Redacted worker log |
| `bridge/audio/` | Ephemeral Fish WAV files, deleted after the companion reads them |
