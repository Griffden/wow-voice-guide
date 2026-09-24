# Contributing

## Layout

```text
addon/WoWClaude/       Lua add-on; the internal name is retained for compatibility
bridge/desktop.js      Electron main process and Deepgram Flux connection
bridge/renderer.js     microphone capture and Fish WAV playback
bridge/bridge.js       WoW transport worker and provider orchestration
bridge/providers.js    OpenAI-compatible, Gemini, and Fish HTTP adapters
bridge/protocol.js     pure pixel/slot protocol helpers
bridge/capture.ps1     screen capture and pixel-strip decoder
setup.js               WoW add-on/slot installer
tests/                 Lua VM, protocol, provider, PCM, and codec tests
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing the transport. WoW's sandbox constraints explain the unusual pixel-out/slot-in design.

## Development

```powershell
npm install
npm test
npm start
```

`npm test` requires Windows because the codec test executes the real PowerShell decoder. Real voice smoke tests require personal Deepgram, brain-provider, and Fish Audio keys. Never commit those keys or `bridge/config.json`.

## Test map

| Test | Coverage |
|---|---|
| `tests/addon_test.js` | Real add-on in a Lua VM: connection, Talk flag, transcript replacement, reply and waypoint |
| `tests/bridge_test.js` | Records, flags, SavedVariables fallback, slot serialization and dedup |
| `tests/providers_test.js` | Structured response normalization, OpenAI-compatible request, Fish request and redaction |
| `tests/audio_utils_test.js` | Browser PCM downsampling/clipping |
| `tests/restore_test.js` | Generated Lua inbox round-trip |
| `tests/codec_test.js` | Pixel stream decoded under synthetic noise and gamma |

## Conventions

- Lua remains 5.1-compatible and capability-checks Forever beta APIs.
- JavaScript is CommonJS, two-space indentation, single quotes.
- Keep credentials in the Electron main/worker side; never pass them into WoW or expose Node integration to the renderer.
- The `slots`, strip dimensions, signal counts, and internal `WoWClaude` identifiers must remain compatible across setup, bridge, and add-on code.
- Add a deterministic test for behavior that does not require a live paid service.
- For exact quest directions, prefer a version-matched licensed data source. Do not solve missing data by relaxing the no-invented-coordinates rule.
