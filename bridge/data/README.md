# Offline WoW: Forever quest data

`forever-quests.json` is the companion's offline quest database: quest names, quest givers with their zone and 0–100 map coordinates, minimum level, faction/race/class limits, prerequisites, breadcrumb and holiday flags. The guide's `quests_near_me` and `quest_info` tools, the "what should I do?" notes, and the zone and quest announcements read it (`bridge/questdb.js`).

## Source and license

The quest data is converted from the [AllTheThings](https://github.com/ATTWoWAddon/AllTheThings) (ATT) WoW: Forever database (`.contrib/.db/forever`), which is MIT licensed. Map ids and names come from the Forever client's `UiMap` table (build 1.60.1.70009) on [wago.tools](https://wago.tools/db2/UiMap?build=1.60.1.70009). The ATT commit used is recorded in the file's `meta.attCommit`. This project does not claim ownership of ATT's data, and the companion does not need the ATT add-on.

ATT's license notice, preserved for the derived data:

```text
MIT License

Copyright (c) 2026 AllTheThings WoW Addon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## What is in it

- Quests from ATT's reviewed Forever files, evaluated for the Forever client the way ATT's own parser does (`FOREVER`/`ANYCLASSIC` branches, timelines at patch 1.60.1). Quests removed before 1.60.1 are left out.
- Quests from ATT's `zzOLD` folder (Classic-era data not yet reviewed for Forever) only where the reviewed files lack them. They carry `"old": 1`, and the guide calls them unverified.
- Coordinates on maps the Forever client does not have are dropped. ATT has few turn-in locations, so quest *givers* are what the database knows.

## Rebuilding

```powershell
npm run build:quests                              # latest ATT commit
node tools/build-quest-db.js --att C:\src\AllTheThings   # a local ATT checkout
```

The converter (`tools/att-parser.js`) reads ATT's Lua data files without running them: it understands ATT's `-- #if` preprocessor comments, tables, calls, constants and simple assignments, and takes quest and NPC names from ATT's trailing comments.

## Record format

```json
"3519": {"n":"A Friend in Need","l":2,"f":"A","pre":[4495],"g":[[8584,54.6,33,1438]]}
```

`n` name, `l` minimum level, `f` faction (`A`/`H`), `r` races, `c` classes, `pre` prerequisite quest ids (`pn`: how many of them are needed), `alt` mutually exclusive quests, `b` breadcrumb, `rep` repeatable, `sk` required skill line, `g` givers as `[npcId, x, y, uiMapId, faction?]` (npcId `0` for a location without a named giver, or just `[npcId]` without coordinates), `m` maps when there are no giver coordinates, `ev` holiday, `old` unverified. `npcs` maps NPC ids to names and `maps` uiMapIDs to zone names.
