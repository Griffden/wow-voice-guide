# WoW Voice Guide — implementation plan

Status: approved direction, implementation follows this document.

## Product promise

A player starts one Windows companion and enables one World of Warcraft: Forever add-on. In game they press **Talk** once, speak normally, stop naturally, and hear a concise answer in a selected Fish Audio voice. The add-on also shows the transcript and answer. Text input remains available as a fallback.

This project does not integrate Muse or Meta. It does not inject code, read game memory, automate player input, or bypass the add-on sandbox.

## Proven foundation

This is an MIT-licensed adaptation of `chelinho139/wow-claude`. Its game transport is retained:

- Add-on to companion: the add-on renders a checksummed strip of 4 px color cells; the companion captures and decodes the strip.
- Companion to add-on: the companion writes replies to pre-created load-on-demand slot add-ons; WoW loads a fresh slot.
- Empty/valid WAV files remain the acknowledgement, readiness, and presence signals.

The adaptation replaces the Claude Code process with a voice-assistant pipeline and packages the microphone/UI portion into the same companion application.

## Architecture

```text
WoWVoice add-on
  Talk button + typed chat + game/quest context
        |
        | pixel strip (out) / load-on-demand slot (in)
        v
WoW Voice companion (one Electron desktop application)
  BrowserWindow microphone capture (16 kHz mono PCM)
        |
        +--> Deepgram Flux /v2/listen
        |      EndOfTurn event decides when the player is done
        |
        +--> configurable guide model (OpenAI-compatible or native Gemini)
        |      returns concise JSON: display text, speech text, optional waypoint
        |
        +--> Fish Audio /v1/tts using the selected public voice model id
               WAV audio is played by the companion
```

Deepgram and Fish are cloud APIs, not extra programs. The desktop companion owns credentials and microphone permission. A future hosted backend can replace direct API calls without changing the add-on protocol.

## Fixed decisions

1. Interaction is press once, talk, automatic end-of-turn, then respond.
2. Deepgram Flux is the initial transcription provider because model-integrated end-of-turn detection is the requested behavior. Start with only final `EndOfTurn`, not speculative `EagerEndOfTurn`.
3. Fish Audio is the only TTS provider. The selected voice is a Fish `reference_id`.
4. The default brain is GPT-6 Luna with reasoning effort `none`. GPT-4.1 Mini, native hosted Gemma 4 26B A4B/31B, and local OpenAI-compatible servers are selectable; there is no Claude dependency.
5. The existing WoW transport is retained because it is already tested on Forever 1.60.1.
6. Voice playback happens in the companion, not in WoW.
7. A new Talk press while listening cancels the capture. A manual Stop control in the companion forces the end of the current Flux turn.
8. API keys never travel through the game or appear in add-on SavedVariables.

## Companion responsibilities

- Launch and supervise the existing game bridge.
- Capture the default microphone with Chromium Web Audio.
- Downsample to signed 16-bit, 16 kHz, mono PCM and send approximately 80 ms chunks to Flux.
- Publish live states back to the add-on: `listening`, `heard: …`, `thinking`, `speaking`.
- Maintain short per-chat conversational history locally.
- Call the configured reasoning endpoint with game context and a strict structured-response prompt.
- Call Fish TTS with `s2.1-pro` or `s2.1-pro-free`, selected `reference_id`, WAV output, and configurable latency.
- Play returned audio and support stop/cancel.
- Provide a desktop settings screen, connection diagnostics, Talk/Stop controls, and a Fish voice-id field.

## Add-on responsibilities

- Rebrand the user-facing surface as WoW Voice Guide while preserving internal names needed for backward-compatible transport.
- Add a prominent Talk button and `/voice` command.
- Send voice-start records using the `v` protocol flag.
- Include character, map, coordinates, selected/super-tracked quest, and quest objective progress when the client exposes those APIs.
- Show the transcript as the user's message after Flux returns it.
- Show listening/thinking/speaking state in the working bubble and mini bar.
- Accept an optional structured waypoint in a reply and expose **Set waypoint** as a user click; never automate movement.
- Keep typed messages as a fallback and accessibility feature.

## Provider contracts

### Deepgram Flux

- WebSocket: `wss://api.deepgram.com/v2/listen`
- Model: `flux-general-en` by default.
- Encoding: `linear16`, sample rate `16000`.
- Default `eot_threshold`: `0.7`; `eot_timeout_ms`: `5000`.
- The final transcript is accepted only from `TurnInfo.event === "EndOfTurn"`.
- Warcraft names are supplied as configurable keyterms.

### Reasoning endpoint

- HTTP POST to either a configurable OpenAI-compatible Chat Completions URL or Gemini's native `generateContent` endpoint for Gemma 4.
- Required response shape:

```json
{
  "display": "Short answer shown in game",
  "speech": "Natural version spoken aloud",
  "waypoint": { "mapId": 1431, "x": 0.452, "y": 0.678, "label": "Optional label" }
}
```

- Waypoints are optional and must be omitted when the model lacks grounded coordinates.
- Malformed JSON degrades safely to a plain text response.

### Fish Audio

- HTTP POST `https://api.fish.audio/v1/tts`.
- `reference_id` is the configured Fish public-library or owned voice-model ID.
- Request WAV for straightforward local playback.
- Voice IDs are user-selected rather than hard-coded because public/community voices can be renamed, removed, or carry different licensing status.

## Configuration and secrets

`bridge/config.json` contains non-secret behavior and may contain local-development keys. Environment variables override secrets:

- `DEEPGRAM_API_KEY`
- `FISH_API_KEY`
- `WOWVOICE_LLM_API_KEY`
- `GEMINI_API_KEY`

The settings UI writes config atomically. Logs redact authorization headers and keys.

## Reliability rules

- Only one voice capture may run at a time.
- A 30-second capture timeout fails visibly and releases the microphone.
- Empty transcripts return to idle without calling the LLM or Fish.
- Provider timeouts use `AbortController`.
- Audio playback failure does not discard the text answer.
- The bridge still publishes final text if Fish fails, with a short speech-error note in the companion only.
- Existing signal/slot fallbacks and `/reload` recovery remain available.

## Verification

- Unit tests for voice flag parsing, structured response parsing, provider request construction, secret redaction, and waypoint serialization.
- Existing protocol, add-on VM, restore, and codec tests continue to pass.
- Add-on VM test covers Talk -> `v` record -> listening state -> final reply -> waypoint click.
- Companion renderer has deterministic PCM conversion tests separated from browser APIs.
- Manual smoke test requires real Deepgram, LLM, and Fish keys and an installed Forever beta client; it is documented but never run in CI.

## Delivery boundary

This implementation delivers source, installer/setup flow, a runnable Electron companion, tests, and Windows packaging configuration. Producing a signed public installer and paying/hosting provider accounts are release operations outside the source build.

## Primary references

- wow-claude foundation: https://github.com/chelinho139/wow-claude
- Deepgram Flux quickstart: https://developers.deepgram.com/docs/flux/quickstart
- Deepgram Flux state machine: https://developers.deepgram.com/docs/flux/state
- Fish TTS endpoint: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
- Fish voice-model listing/licensing field: https://docs.fish.audio/api-reference/endpoint/model/list-models
- GPT-6 Luna model and pricing: https://developers.openai.com/api/docs/models/gpt-6-luna
- GPT-4.1 Mini model and pricing: https://developers.openai.com/api/docs/models/gpt-4.1-mini
- Gemma 4 hosted model IDs: https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
