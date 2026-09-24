# Architecture

## Components

```text
WoW add-on                         Electron companion
-----------                        ------------------
Talk button -- pixel strip ------> capture.ps1 -> bridge worker
                                          |
                                          +-> renderer microphone (16 kHz PCM)
                                          +-> Deepgram Flux /v2/listen
                                          +-> selected guide LLM
                                          +-> Fish Audio /v1/tts -> renderer playback
                                          |
answer <---- load-on-demand slot ----------+
```

WoW's Lua sandbox has no general network, microphone, or arbitrary runtime file APIs. The companion is therefore a required boundary component. Deepgram, the LLM host, and Fish Audio are remote APIs called by that one companion.

The desktop main process owns credentials, provider sockets, bridge supervision, and WAV file access. The renderer is context-isolated and receives only a narrow preload API for configuration, microphone PCM, status, and playback.

## Outbound game protocol

The add-on draws a checksummed byte stream as RGB values in 4-pixel cells. `capture.ps1` reads the client window with Windows Graphics Capture and emits decoded JSON records.

Records use ASCII record separator (`0x1e`) and unit separator (`0x1f`):

```text
session, chat, id, cwd, flags, name, [context,] text
```

Relevant flags:

- `h`: hello/connection handshake
- `c`: a game-context field is present
- `d`: forget the chat
- `v`: start a voice turn
- `x`: cancel a voice turn (reserved by the worker protocol)

For a voice turn, the worker acknowledges the request and asks the Electron main process to start Flux. The renderer starts its microphone only after the WebSocket opens. About 85 ms of browser audio at a time is converted to mono signed 16-bit 16 kHz PCM. `EndOfTurn` supplies the final transcript; `ForceEndTurn` supports the manual finish button.

## Brain and response contract

The worker combines the current transcript with the last 12 local chat messages and the most recently acknowledged game context. OpenAI-compatible Chat Completions and native Gemini `generateContent` are implemented.

The brain is asked for:

```json
{
  "display": "concise in-game answer",
  "speech": "natural spoken answer",
  "waypoint": { "mapId": 1431, "x": 0.452, "y": 0.678, "label": "Darkshire" }
}
```

Malformed JSON degrades to plain text. Waypoints are normalized and rejected unless the map ID and normalized coordinates are valid. The model is told not to invent coordinates; the player must still click **Set waypoint** in the add-on.

## Fish Audio

The worker posts `speech` to Fish `/v1/tts` with the configured voice `reference_id`, requests a mono WAV, and sends the resulting local file path to the parent. Electron reads and deletes the temporary file, sends base64 audio to the renderer, and plays it. A Fish failure never discards the text answer.

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
