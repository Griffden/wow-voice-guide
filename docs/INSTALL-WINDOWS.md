# Windows installation

## 1. Prepare accounts

Create API keys for [Deepgram](https://console.deepgram.com/) and [Fish Audio](https://fish.audio/). The companion includes four selectable Fish voice IDs (Peon, Furbolg, Knight, and Asmongold) and also accepts a custom Fish public-library or owned voice model ID. Peon is the fresh-install default. Also prepare either an OpenAI API key, a Google AI Studio key for Gemma 4, or a running local OpenAI-compatible server.

## 2. Install the source build

Install Node.js 22.12 or newer, open PowerShell in this repository, and run:

```powershell
npm install
node setup.js
```

If automatic detection misses the beta client:

```powershell
node setup.js --wow "D:\World of Warcraft\_classic_beta_"
```

If more than one account exists under `WTF\Account`, pass `--account NAME`.

The script copies the add-on to WoW, creates `bridge/config.json`, builds 200 load-on-demand response slots, and creates the signal files. The large count of small generated files is expected.

## 3. Restart WoW

Fully quit the client and relaunch it. New add-on folders are discovered only at process start. On character select, enable **WoW Voice Guide**; leave its numbered slot add-ons enabled.

Use windowed or borderless mode. Exclusive fullscreen can prevent the screen-capture transport from seeing the add-on's tiny pixel strip.

## 4. Start and configure the companion

```powershell
npm start
```

Windows will ask for microphone permission the first time a Talk request reaches the companion. In Settings, enter:

- Deepgram API key
- Brain preset and API key or local endpoint
- Fish Audio API key and a built-in or custom voice (Peon is preselected; its model ID is editable)

Click **Save and restart bridge**.

## 5. Use it

In game:

- `/voice-guide` opens the window.
- Press **Talk**, speak, and stop naturally.
- `/voice` begins the same one-press listening flow immediately.
- The companion's **Finish now** forces a slow/paused turn to end.
- The answer appears in game and plays through the desktop companion in the selected Fish voice.

## Troubleshooting

**The status does not turn green.** Keep the companion open, verify the game is windowed/borderless, then click **Connect**. Check the companion log for the detected process and add-on path.

**The microphone never opens.** Check Windows Settings → Privacy & security → Microphone and allow desktop apps. A Talk request, not merely launching the companion, triggers capture.

**Deepgram closes immediately.** Verify the key and that `deepgram.model` is a Flux model. This build uses `/v2/listen`; `/v1/listen` is not compatible with Flux.

**The model returns text but there is no voice.** Verify the Fish key, the exact voice `_id`, and access to that model. Try `s2.1-pro-free` if the account uses the free developer tier.

**A local model rejects the request.** Some compatibility servers do not implement `response_format`. Add `"responseFormat": false` to the `llm` block.

**A reply says a folder does not exist.** `defaultCwd` is inherited from the upstream project-oriented bridge but is not important to voice answers. Point it at any existing local folder.

**The answer is wrong about an exact quest location.** Quest questions use indexed web results and show source links, but those results may be outdated or from a different WoW edition. The app has no authoritative Forever quest-location database. Do not trust guessed coordinates; the prompt asks the guide to omit a waypoint when it lacks grounded data.

**Quest web lookup says it needs an OpenAI key.** Choose an OpenAI brain preset and save its API key in companion Settings. This first player-guide version does not use the Gemini or local-model key for web search.

Run `npm test` to verify all provider-independent paths. Real-provider and in-game smoke tests require your own keys and running client.
