# Pixel Agents — Architecture & Developer Reference

> **Purpose**: Complete technical reference for LLMs and developers making future changes.
> Read `CLAUDE.md` first for the condensed reference. This document goes deeper on every subsystem.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Build Targets](#2-build-targets)
3. [Directory Structure](#3-directory-structure)
4. [IPC Message Protocol](#4-ipc-message-protocol)
5. [Backend: Agent Lifecycle](#5-backend-agent-lifecycle)
6. [Backend: JSONL Parsing](#6-backend-jsonl-parsing)
7. [Backend: State Persistence](#7-backend-state-persistence)
8. [Frontend: React Architecture](#8-frontend-react-architecture)
9. [Frontend: Game Engine](#9-frontend-game-engine)
10. [Frontend: Rendering Pipeline](#10-frontend-rendering-pipeline)
11. [Frontend: Layout Editor](#11-frontend-layout-editor)
12. [Asset System](#12-asset-system)
13. [TypeScript Conventions](#13-typescript-conventions)
14. [Adding New Features](#14-adding-new-features)
15. [Known Issues & TODO](#15-known-issues--todo)

---

## 1. Project Overview

Pixel Agents is a **pixel art office visualizer** for Claude Code agents. Each running `claude` process appears as an animated 16×32-pixel character in a top-down office scene. Characters animate based on what Claude is doing (walking, typing, reading) and show speech bubbles when waiting for input or a permission decision.

| Entry | Transport | Launch Claude |
|-------|-----------|---------------|
| `electron/main.ts` | Electron IPC (`ipcMain`/`ipcRenderer`) | AppleScript → Terminal.app |

The React UI (`webview-ui/`) communicates with the main process through IPC abstracted in `vscodeApi.ts`.

### Data flow summary

```
Claude process
    │ writes JSONL lines
    ▼
~/.claude/projects/<hash>/<session-id>.jsonl
    │ fs.watch + polling
    ▼
fileWatcher.ts → transcriptParser.ts → timerManager.ts
    │ postMessage()
    ▼
React webview (useExtensionMessages.ts)
    │ updates OfficeState
    ▼
gameLoop.ts → renderer.ts → <canvas>
```

---

## 2. Build System

```
esbuild.electron.js
  electron/main.ts      → dist/electron/main.js     (CJS, Node.js)
  electron/preload.ts   → dist/electron/preload.js   (CJS, Node.js)

webview-ui/ (Vite)      → dist/webview/              (Browser bundle)
esbuild.electron.js (copyAssets) → dist/assets/      (PNG data for main process)
```

**Commands:**
```sh
npm run build               # dev build (sourcemaps, no minify)
npm run start               # build + launch electron
npm run start:dev           # ELECTRON_DEV_URL=http://localhost:5173 electron .
npm run watch:electron-main # watch mode for main process only
npm run watch:webview       # vite dev server on :5173
npm run check-types         # tsc --noEmit
npm run package:mac         # production DMG → release/
```

**Asset resolution (`getAssetsRoot()`):**
```
app.isPackaged → process.resourcesPath/          (extraResources in electron-builder)
  else         → dist/                           (built by esbuild copyAssets)
  else         → webview-ui/public/              (raw dev source)
```

### `tsconfig.json`

Includes `electron/**/*` and `src/**/*`. Has `"lib": ["ES2022", "DOM"]` (DOM needed for preload's `window.dispatchEvent`).

---

## 3. Directory Structure

```
Pixel_Agents/
├── electron/                   ← Electron main-process code
│   ├── main.ts                 ← BrowserWindow, IPC handlers, orchestration
│   ├── preload.ts              ← Context bridge (window.electronIpc ↔ ipcMain)
│   ├── appState.ts             ← JSON file persistence (~/.pixel-agents/)
│   └── terminalLauncher.ts     ← AppleScript → Terminal.app launcher
│
├── src/                        ← Shared backend (Node.js)
│   ├── types.ts                ← AgentState, PersistedAgent, ElectronTerminalHandle
│   ├── constants.ts            ← ALL magic numbers (timing, truncation, asset parsing, IDs)
│   ├── agentManager.ts         ← Agent CRUD: launch, remove, persist, restore, send status
│   ├── fileWatcher.ts          ← fs.watch + polling, readNewLines, multi-project scan
│   ├── transcriptParser.ts     ← JSONL line → postMessage() events
│   ├── timerManager.ts         ← Permission/waiting timer logic
│   ├── assetLoader.ts          ← PNG → SpriteData, catalog loading, send-to-webview helpers
│   └── layoutPersistence.ts    ← ~/.pixel-agents/layout.json read/write/watch
│
├── webview-ui/src/             ← React + TypeScript (Vite)
│   ├── vscodeApi.ts            ← IPC shim (Electron IPC bridge | no-op fallback)
│   ├── constants.ts            ← ALL webview magic numbers (grid, animation, camera, editor)
│   ├── notificationSound.ts    ← Web Audio API chime on agent turn completion
│   ├── App.tsx                 ← Composition root, hooks + all components
│   ├── hooks/
│   │   ├── useExtensionMessages.ts ← ALL backend message handling + OfficeState updates
│   │   ├── useEditorActions.ts     ← Layout editor state + callbacks
│   │   └── useEditorKeyboard.ts    ← Keyboard shortcuts (Ctrl+Z, R, T, Esc, etc.)
│   ├── components/
│   │   ├── BottomToolbar.tsx       ← "+ Agent", Layout toggle, Settings button
│   │   ├── ZoomControls.tsx        ← +/- zoom buttons (top-right)
│   │   ├── SettingsModal.tsx       ← Settings, Export/Import layout, Sound, Debug
│   │   └── DebugView.tsx           ← Debug overlay panel
│   └── office/
│       ├── types.ts                ← Interfaces + re-exports constants
│       ├── toolUtils.ts            ← STATUS_TO_TOOL map, extractToolName(), defaultZoom()
│       ├── colorize.ts             ← Dual-mode: Colorize (grayscale→HSL) + Adjust (HSL shift)
│       ├── floorTiles.ts           ← Floor sprite storage + colorized cache
│       ├── wallTiles.ts            ← Wall auto-tile bitmask rendering
│       ├── sprites/
│       │   ├── spriteData.ts       ← Pixel data: chars, furniture, bubbles + template fallbacks
│       │   └── spriteCache.ts      ← SpriteData → offscreen canvas, per-zoom WeakMap cache
│       ├── editor/
│       │   ├── editorActions.ts    ← Pure layout ops: paint, place, remove, move, rotate…
│       │   ├── editorState.ts      ← Imperative editor state: tool, ghost, selection, undo
│       │   └── EditorToolbar.tsx   ← React toolbar/palette for edit mode
│       ├── layout/
│       │   ├── furnitureCatalog.ts ← Dynamic catalog from loaded assets, getCatalogEntry()
│       │   ├── layoutSerializer.ts ← OfficeLayout ↔ runtime (tileMap, furniture, seats)
│       │   └── tileMap.ts          ← Walkability grid, BFS pathfinding
│       └── engine/
│           ├── characters.ts       ← Character FSM: idle/walk/type + wander AI
│           ├── officeState.ts      ← Central game world: layout, chars, seats, subagents
│           ├── gameLoop.ts         ← rAF loop with delta time cap
│           ├── renderer.ts         ← Canvas: tiles, z-sorted entities, overlays
│           └── matrixEffect.ts     ← Matrix-style spawn/despawn digital rain
│
├── scripts/                    ← Asset pipeline (run manually, not part of build)
│   ├── 0-import-tileset.ts     ← CLI wrapper to import a tileset image
│   ├── 1-detect-assets.ts      ← Flood-fill to detect asset boundaries
│   ├── 2-asset-editor.html     ← Browser UI for position/bounds editing
│   ├── 3-vision-inspect.ts     ← Claude vision API for auto-metadata
│   ├── 4-review-metadata.html  ← Browser UI for metadata review
│   ├── 5-export-assets.ts      ← Export individual PNGs + furniture-catalog.json
│   ├── asset-manager.html      ← Unified editor (Stage 2+4), File System Access API
│   ├── generate-walls.js       ← Generate walls.png (4×4 grid of 16 auto-tile pieces)
│   └── wall-tile-editor.html   ← Browser UI for wall tile appearance
│
├── webview-ui/public/assets/   ← Runtime assets (committed to repo)
│   ├── furniture/
│   │   ├── furniture-catalog.json  ← Asset metadata (generated by scripts/5-export-assets.ts)
│   │   └── *.png                   ← Individual furniture sprites
│   ├── characters/
│   │   └── char_0.png … char_5.png ← Pre-colored character sheets (112×96, 7 frames × 3 dirs)
│   ├── floors.png              ← 7 floor patterns (112×16, grayscale, 16×16 each)
│   ├── walls.png               ← 16 wall auto-tile pieces (64×128, 4×4 grid)
│   └── default-layout.json     ← Bundled office layout (fallback for new installs)
│
├── build/                      ← electron-builder resources
│   ├── icon.png                ← 1024×1024 app icon (scaled from icon.png)
│   └── entitlements.mac.plist  ← macOS hardened runtime entitlements
│
├── esbuild.electron.js         ← Electron app build (main + preload)
├── tsconfig.json               ← TypeScript config
├── electron-builder.json       ← macOS DMG packaging config
└── package.json                ← Deps + scripts
```

---

## 4. IPC Message Protocol

All communication between the backend (Node.js) and frontend (React) is via `postMessage`. Messages are plain JSON objects with a `type` discriminator.

### 4.1 Transport layer

```
webview → main:   ipcRenderer.send('webview-message', msg)
                  ipcMain.on('webview-message', handler)

main → webview:   win.webContents.send('main-message', msg)
                  ipcRenderer.on('main-message', (_, data) => window.dispatchEvent(...))
```

### 4.2 Webview → Backend messages

| `type` | Payload | Description |
|--------|---------|-------------|
| `webviewReady` | — | Sent on mount; triggers full initialization sequence |
| `openClaude` | — | Launch new Terminal.app window with `claude --session-id <uuid>` |
| `focusAgent` | `{ id }` | Bring that agent's terminal to front |
| `closeAgent` | `{ id }` | Remove agent, kill terminal, despawn character |
| `saveLayout` | `{ layout: OfficeLayout }` | Persist layout to `~/.pixel-agents/layout.json` |
| `saveAgentSeats` | `{ seats: Record<id, {palette, hueShift, seatId}> }` | Persist character appearance/position |
| `setSoundEnabled` | `{ enabled: boolean }` | Toggle notification sound |
| `openSessionsFolder` | — | Open `~/.claude/projects/` in Finder |
| `exportLayout` | — | Show save dialog → write JSON file |
| `importLayout` | — | Show open dialog → validate + load JSON |

### 4.3 Backend → Webview messages (initialization sequence)

Sent in this order on `webviewReady`:

1. `settingsLoaded` — `{ soundEnabled: boolean }`
2. `characterSpritesLoaded` — `{ characters: CharacterDirectionSprites[] }` (6 entries)
3. `floorTilesLoaded` — `{ sprites: string[][][] }` (7 patterns, 16×16 each)
4. `wallTilesLoaded` — `{ sprites: string[][][] }` (16 bitmask pieces, 16×32 each)
5. `furnitureAssetsLoaded` — `{ catalog: FurnitureAsset[], sprites: Record<id, string[][]> }`
6. `layoutLoaded` — `{ layout: OfficeLayout | null }`
7. `existingAgents` — `{ agents: number[], agentMeta: Record<id, {palette, hueShift, seatId}> }`

### 4.4 Backend → Webview messages (agent lifecycle)

| `type` | Payload | Description |
|--------|---------|-------------|
| `agentCreated` | `{ id }` | New agent spawned (char appears with matrix effect) |
| `agentClosed` | `{ id }` | Agent removed (char despawns with matrix effect) |
| `agentSelected` | `{ id }` | Terminal focus changed |

### 4.5 Backend → Webview messages (tool activity)

| `type` | Payload | Description |
|--------|---------|-------------|
| `agentToolStart` | `{ id, toolId, status }` | Tool invoked; `status` is human-readable label |
| `agentToolDone` | `{ id, toolId }` | Tool completed (delayed 300ms to prevent flicker) |
| `agentToolsClear` | `{ id }` | All tools cleared (on turn_duration or new prompt) |
| `agentStatus` | `{ id, status: 'active'|'waiting' }` | Turn state change |
| `agentToolPermission` | `{ id }` | Possible permission wait (amber bubble) |
| `agentToolPermissionClear` | `{ id }` | Permission cleared (data resumed) |
| `subagentToolStart` | `{ id, parentToolId, toolId, status }` | Sub-agent tool start |
| `subagentToolDone` | `{ id, parentToolId, toolId }` | Sub-agent tool done |
| `subagentClear` | `{ id, parentToolId }` | Task tool completed → remove sub-agent |
| `subagentToolPermission` | `{ id, parentToolId }` | Sub-agent permission wait |

---

## 5. Backend: Agent Lifecycle

### 5.1 New agent (click "+ Agent")

```
UI → openClaude message
  └─ agentManager.launchNewTerminal()
       ├─ crypto.randomUUID() → sessionId
       ├─ terminalLauncher.launchClaudeTerminal(name, sessionId, cwd)
       │    └─ AppleScript: Terminal.app → "cd <cwd> && claude --session-id <uuid>"
       ├─ Pre-register expectedFile = ~/.claude/projects/<hash>/<uuid>.jsonl
       ├─ agents.set(id, AgentState{...})
       ├─ postMessage({ type: 'agentCreated', id })
       ├─ ensureMultiProjectScan() [if not already running]
       └─ setInterval poll: when expectedFile appears → startFileWatching()
```

### 5.2 Auto-detected agent (external terminal)

```
ensureMultiProjectScan() [runs every 1s]
  └─ scanAllProjects(~/.claude/projects/)
       └─ for each subdir, for each .jsonl not in knownJsonlFiles:
            ├─ agents.set(id, AgentState{ terminalRef: dummy })
            ├─ postMessage({ type: 'agentCreated', id })
            └─ startFileWatching(id, file, ...)
               readNewLines(id, ...)  ← read from start
```

### 5.3 Agent restore (app restart)

```
webviewReady → restoreAgents()
  └─ appState.getAgents() → PersistedAgent[]
       └─ for each persisted:
            ├─ check: fs.existsSync(p.jsonlFile) AND mtimeMs < 30min ago
            ├─ if live: agents.set(p.id, AgentState{ fileOffset = stat.size })
            │           startFileWatching() [skip to EOF — don't replay history]
            └─ if stale: skip (log "stale agent")
  └─ doPersist() [removes stale entries from file]
  └─ ensureMultiProjectScan() [start watching for new sessions]
```

### 5.4 Agent removal (close button)

```
UI → closeAgent message
  └─ removeAgent(id, ...)
       ├─ clearInterval(jsonlPollTimer)
       ├─ fileWatchers.get(id).close()
       ├─ clearInterval(pollingTimer)
       ├─ cancelWaitingTimer + cancelPermissionTimer
       ├─ agent.terminalRef.kill() [best-effort]
       └─ agents.delete(id)
            doPersistAgents()
```

### 5.5 `/clear` detection

When the user types `/clear` in Claude, it creates a NEW `.jsonl` file in the same project dir. `ensureProjectScan` detects this:
```
new .jsonl file appears in projectDir AND activeAgentId !== null
  └─ reassignAgentToFile(activeAgentId, newFile)
       ├─ stop old file watching
       ├─ clearAgentActivity()
       ├─ agent.jsonlFile = newFile; agent.fileOffset = 0
       └─ startFileWatching() on new file
```

---

## 6. Backend: JSONL Parsing

### 6.1 File watching (`fileWatcher.ts`)

Hybrid approach for reliability:
- **Primary:** `fs.watch(filePath)` — low latency, but unreliable on some systems
- **Backup:** `setInterval` every 2s — always works

`readNewLines()` logic:
1. `stat.size <= fileOffset` → nothing new, return
2. Read only new bytes (`readSync` at offset)
3. Advance `fileOffset = stat.size`
4. Append to `lineBuffer`, split on `\n`
5. Last element (possibly incomplete line) → saved back to `lineBuffer`
6. Any new data → cancel waiting/permission timers + clear permission bubble

### 6.2 Record types (`transcriptParser.ts`)

JSONL files contain newline-delimited JSON records:

**`assistant` record** — Claude's response:
```json
{
  "type": "assistant",
  "message": {
    "content": [
      { "type": "tool_use", "id": "toolu_xxx", "name": "Read", "input": {"file_path": "..."} },
      { "type": "text", "text": "..." }
    ]
  }
}
```
→ For each `tool_use`: emit `agentToolStart`, start permission timer if non-exempt

**`user` record** — Tool results or new prompt:
```json
{ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "toolu_xxx" }] } }
```
→ For `tool_result`: emit `agentToolDone` (delayed 300ms)
→ For text prompt: `clearAgentActivity()`, reset `hadToolsInTurn`

**`system` record with `subtype: "turn_duration"`** — Reliable turn-end signal:
→ Clears all tool state, sets `isWaiting = true`, emits `agentStatus: waiting`

**`progress` record** — Sub-agent and long-running tool data:
- `data.type === 'bash_progress'` or `'mcp_progress'` → restart permission timer
- `data.type === 'agent_progress'` with parent `Task` tool → emit `subagentToolStart/Done`

### 6.3 Idle detection strategy

Two signals, because `turn_duration` is only emitted for tool-using turns:

| Situation | Signal | How detected |
|-----------|--------|-------------|
| Tool-using turn ends | `system` + `subtype: "turn_duration"` | Reliable, ~98% of turns |
| Text-only turn ends | 5s silence timer | `TEXT_IDLE_DELAY_MS = 5000ms` |

The text-idle timer (`startWaitingTimer`) is only started when `hadToolsInTurn === false`. Any arriving tool_use sets `hadToolsInTurn = true` and suppresses the timer for the rest of that turn.

### 6.4 Permission detection

When a non-exempt tool (anything except `Task`, `AskUserQuestion`) is started, a 7-second timer fires. If still active after 7s → emit `agentToolPermission` (amber dots bubble). If data resumes before 7s → cancel timer, clear bubble.

Permission-exempt tools: `Task`, `AskUserQuestion` (these intentionally wait for input/subagent completion).

---

## 7. Backend: State Persistence

### 7.1 Files written

All files live in `~/.pixel-agents/`:

| File | Written by | Content |
|------|-----------|---------|
| `layout.json` | `layoutPersistence.ts` | `OfficeLayout` (tiles, furniture, colors) |
| `agents.json` | `electron/appState.ts` | `PersistedAgent[]` |
| `agent-seats.json` | `electron/appState.ts` | `Record<id, {palette, hueShift, seatId}>` |
| `settings.json` | `electron/appState.ts` | `{ soundEnabled: boolean }` |
| `working-directory.json` | `electron/appState.ts` | `{ cwd: string }` |

All writes use atomic pattern: write to `.tmp` → `rename()`.

### 7.2 Layout file watching

`watchLayoutFile()` uses the same hybrid fs.watch + polling pattern:
- On change: parse JSON, call `onExternalChange(layout)` callback
- `markOwnWrite()` sets `skipNextChange = true` so we don't re-apply our own write
- Used for cross-process sync (e.g., multiple instances sharing the same layout)

### 7.3 Default layout

Load order when no `~/.pixel-agents/layout.json` exists:
1. Try `assetsRoot/assets/default-layout.json` (bundled)
2. If missing → `createDefaultLayout()` in OfficeState (generates minimal 20×11 room)

To update the bundled default:
- App menu → "Export Layout as Default" (writes to `webview-ui/public/assets/default-layout.json`)
- In Electron: App menu → "Export Layout as Default"

---

## 8. Frontend: React Architecture

### 8.1 State model

React state is minimal. The game world lives in an **imperative `OfficeState` singleton** (not React state):

```
App.tsx
├── officeStateRef: { current: OfficeState }     ← singleton, not React state
│   getOfficeState() → lazy initializer
│
├── useExtensionMessages(getOfficeState, ...)     ← message handler hook
│   ├── React state: agents[], selectedAgent, agentTools, agentStatuses,
│   │               subagentTools, subagentCharacters, layoutReady, loadedAssets
│   └── directly mutates OfficeState (os.addAgent, os.setAgentTool, ...)
│
├── useEditorActions(getOfficeState, ...)         ← editor state + callbacks
│   ├── React state: editorMode, selectedTool, catalog, ghost, etc.
│   └── returns callbacks: onPaint, onPlace, onRemove, etc.
│
└── useEditorKeyboard(editorState, callbacks)    ← keyboard effect, no state
```

### 8.2 `useExtensionMessages.ts` — message handler

This is the most important hook. It:
1. Adds `window.addEventListener('message', handler)` on mount
2. Sends `{ type: 'webviewReady' }` to trigger initialization
3. Handles EVERY incoming backend message (see Section 4)
4. Buffers `existingAgents` until `layoutLoaded` (so seat assignments work correctly)

**Critical ordering:** `furnitureAssetsLoaded` arrives before `layoutLoaded`. The catalog must be built before the layout so `getCatalogEntry()` works when deserializing furniture.

### 8.3 `OfficeState` class

Central imperative game world. Key methods:

| Method | Description |
|--------|-------------|
| `rebuildFromLayout(layout, shift?)` | Full rebuild: tileMap, furniture, seats, relocate chars |
| `addAgent(id, palette?, hueShift?, seatId?, skipSpawn?)` | Create character, assign seat |
| `removeAgent(id)` | Trigger despawn effect, clean up |
| `addSubagent(parentId, toolId)` | Create sub-agent at closest free seat to parent |
| `removeSubagent(parentId, toolId)` | Remove sub-agent character |
| `setAgentTool(id, toolName)` | Update character animation state |
| `setAgentActive(id, active)` | Toggle active/idle |
| `showWaitingBubble(id)` / `showPermissionBubble(id)` | Speech bubbles |
| `getLayout()` | Serialize current world state back to `OfficeLayout` |
| `rebuildFurnitureInstances()` | Auto-state: swap electronics ON/OFF based on agents |

---

## 9. Frontend: Game Engine

### 9.1 Character FSM

```
States: IDLE ←→ WALK → TYPE
                 ↑
              (path found to seat)

IDLE:  wander randomly (BFS to random walkable tile)
       after wanderLimit moves → rest at seat
WALK:  follow path[] array, one tile per step
       arrive at seat → TYPE
TYPE:  animate typing or reading based on active tool
       turn ends → IDLE
```

**Animation frames** (from `char_N.png`, 7 frames per direction row):
- `walk1, walk2, walk3` — walking animation (cycles 0→2)
- `walk2` — idle standing pose (frame 1)
- `type1, type2` — typing animation (cycles 3→4)
- `read1, read2` — reading animation (cycles 5→6)

**Directions:** 0=DOWN, 1=LEFT (flipped RIGHT), 2=RIGHT, 3=UP. Each direction occupies one 32px row in the sprite sheet.

### 9.2 Z-sorting

All entities (furniture, characters, walls) are z-sorted by their `zY` value before rendering. Higher `zY` renders on top.

Special cases:
- Characters: `zY = ch.y + TILE_SIZE/2 + 0.5` (renders in front of same-row chairs)
- Back chairs: `zY = (row+1)*TILE_SIZE + 1` (renders in FRONT of character sitting in it)
- Surface items: `zY = max(spriteBottom, deskZY + 0.5)` (in front of desk)
- Wall pieces: `zY = (row+1)*TILE_SIZE` (same as furniture at that row)

### 9.3 Pathfinding

BFS on the walkability grid (`tileMap.ts`). Chair tiles are blocked for all characters EXCEPT the chair's own assigned character. `withOwnSeatUnblocked(charId)` returns a modified blocked set for per-character pathfinding.

### 9.4 Spawn/Despawn effect (`matrixEffect.ts`)

16 vertical columns × 0.3s duration. Green ASCII rain sweeps top-to-bottom:
- **Spawn:** rain sweeps down, character pixels revealed behind it
- **Despawn:** character pixels consumed by rain trails
- During effect: normal FSM is paused; character skips hit-testing

### 9.5 Camera

Pan: middle-mouse drag (tracks `panRef`). Smooth follow: `cameraFollowId` — camera lerps toward followed character each frame. Set on agent click, cleared on deselection or manual pan.

Default zoom: `Math.round(2 * devicePixelRatio)` — looks correct on Retina (4px sprite pixels) and standard displays (2px).

---

## 10. Frontend: Rendering Pipeline

### 10.1 Game loop

```typescript
// gameLoop.ts
requestAnimationFrame(loop)
  dt = min(now - lastTime, MAX_DELTA_TIME_SEC)  // cap at 0.1s
  callbacks.update(dt)
  callbacks.render(ctx)
```

### 10.2 Render order

1. **Floor tiles** — TileType.FLOOR_1..7, colorized from FloorColor per tile
2. **Z-sorted layer** — ALL entities (walls, furniture, characters) sorted by zY
   - Each entity draws its sprite at pixel-perfect position
   - Wall sprites extend 16px above tile (3D face illusion)
3. **Bubbles** — Permission (amber dots) or waiting (green checkmark) above characters
4. **Selection rings** — White outline around selected character
5. **Edit mode overlays** — Grid lines, ghost preview, selection highlight

### 10.3 Sprite rendering

`SpriteData = string[][]` — 2D array of `''` (transparent) or `'#RRGGBB'` hex strings.

`spriteCache.ts`:
- `getSprite(data, zoom)` — returns offscreen canvas, keyed by `(data_reference, zoom)`
- `WeakMap<SpriteData, Map<zoom, OffscreenCanvas>>` — auto-GC when sprite data is released
- Canvas is created at `width × zoom` pixels; each pixel becomes a `zoom × zoom` rectangle
- Outline sprites: same cache with outline drawn first (4-directional white pixels)

### 10.4 Colorization (`colorize.ts`)

Two modes selected by `FloorColor.colorize?`:

| Mode | When used | Effect |
|------|-----------|--------|
| **Colorize** | `colorize: true` | Photoshop-style: grayscale → lightness → fixed H/S |
| **Adjust** | `colorize: false` (default) | Shifts existing pixel H/S/L by delta amounts |

Used for:
- Floor tiles: always Colorize mode (grayscale source PNGs)
- Furniture: Adjust mode (colored source PNGs)
- Characters with hue shift: `adjustSprite()` rotates hue only

---

## 11. Frontend: Layout Editor

### 11.1 Tools

| Tool | Key | Action |
|------|-----|--------|
| SELECT | — | Click to select furniture, drag to move |
| FLOOR | — | Click/drag to paint floor tiles |
| WALL | — | Click/drag to add walls; on existing wall = remove |
| ERASE | — | Set tiles to VOID (transparent, non-walkable) |
| FURNITURE | — | Place furniture (ghost preview) |
| FURNITURE_PICK | — | Eyedropper: copy type+color from placed furniture |
| EYEDROPPER | — | Pick floor pattern+color |

**Right-click** in floor/wall/erase tools → erase to VOID (supports drag-erasing).

### 11.2 Undo/Redo

50-level undo stack in `editorState.ts`. Entries are full `OfficeLayout` snapshots. `EditActionBar` shows when `isDirty` (unsaved changes since last save).

### 11.3 Grid expansion

Ghost tiles appear 1 row/col outside the grid in floor/wall/erase modes. Clicking a ghost tile calls `expandLayout()` which grows the grid by 1 in that direction. Expanding left/up shifts all existing furniture positions and character positions.

### 11.4 Furniture placement rules

- `canPlaceOnWalls: true` → item ONLY goes on wall tiles (bottom row of footprint must be on wall)
- `canPlaceOnSurfaces: true` → item can overlap `isDesk` furniture tiles
- `backgroundTiles: N` → top N footprint rows allow furniture overlap and character walkthrough
- No two non-background footprints can overlap
- Cannot place furniture on VOID tiles (except `canPlaceOnWalls` items extending into void above)

---

## 12. Asset System

### 12.1 Furniture catalog (`furniture-catalog.json`)

```json
{
  "assets": [
    {
      "id": "DESK_FRONT",
      "name": "Desk (Front)",
      "label": "Desk",
      "category": "desks",
      "file": "assets/furniture/desk_front.png",
      "width": 32, "height": 32,
      "footprintW": 2, "footprintH": 2,
      "isDesk": true,
      "canPlaceOnWalls": false,
      "groupId": "DESK",
      "orientation": "front",
      "state": null
    }
  ]
}
```

Asset naming convention: `{BASE}[_{ORIENTATION}][_{STATE}]`
- Orientations: `FRONT`, `BACK`, `LEFT`, `RIGHT`
- States: `ON`, `OFF`

**Rotation groups:** Items sharing `groupId` rotate through each other. `buildDynamicCatalog()` builds `rotationGroups: Map<groupId, FurnitureCatalogEntry[]>`. Editor palette shows only the `front` orientation (or first available).

**State groups:** Items sharing `groupId` + same `orientation` with different `state` values. `stateGroups: Map<groupId+orientation, {on,off}>`. Auto-state swaps electronics to ON when agent faces a nearby desk.

### 12.2 Character sprites

Six pre-colored PNGs at `assets/characters/char_0.png` … `char_5.png`, each `112×96`:
- 7 columns × 16px = 7 frames
- 3 rows × 32px = 3 directions (down=row0, up=row1, right=row2)
- Left direction = right sprites flipped at render time
- Generated by `scripts/export-characters.ts` which bakes colors into pixel templates

When `hueShift !== 0`: `hueShiftSprites()` applies `adjustSprite()` (HSL hue rotation) to all frames before caching.

### 12.3 Wall tiles

`walls.png` = 64×128 PNG containing 16 auto-tile pieces in a 4×4 grid:
- Piece at bitmask M: `col = M % 4`, `row = floor(M / 4)`
- Bitmask bits: N=1, E=2, S=4, W=8 (which neighbors are also walls)
- Each piece: 16px wide × 32px tall (extends 16px above the tile for 3D face)

### 12.4 Asset loading sequence

```
webviewReady received
  │
  ├─ loadCharacterSprites()  → characterSpritesLoaded → setCharacterTemplates()
  ├─ loadFloorTiles()        → floorTilesLoaded       → setFloorSprites()
  ├─ loadWallTiles()         → wallTilesLoaded        → setWallSprites()
  ├─ loadFurnitureAssets()   → furnitureAssetsLoaded  → buildDynamicCatalog()
  └─ sendLayout()            → layoutLoaded           → rebuildFromLayout()
                                                           (catalog must be ready first!)
```

---

## 13. TypeScript Conventions

### 13.1 Enforced constraints (from `tsconfig.json`)

- **No enums** (`erasableSyntaxOnly`) → use `as const` objects:
  ```typescript
  export const TileType = { WALL: 0, FLOOR_1: 1, VOID: 8 } as const;
  type TileType = typeof TileType[keyof typeof TileType];
  ```
- **`import type`** required for type-only imports (`verbatimModuleSyntax`):
  ```typescript
  import type { AgentState } from './types.js';  // ✓
  import { AgentState } from './types.js';         // ✗ (type-only)
  ```
- **`.js` extensions** in imports (Node16 module resolution):
  ```typescript
  import { foo } from './bar.js';  // ✓ even though file is bar.ts
  ```
- **`noUnusedLocals` / `noUnusedParameters`** — all declared variables must be used

### 13.2 Magic numbers

**Never** add inline constants. Always add to the relevant constants file:
- `src/constants.ts` — backend timing, truncation, asset parsing
- `webview-ui/src/constants.ts` — grid sizes, animation speeds, rendering offsets, camera

### 13.3 Type aliases for shared abstractions

```typescript
// Shared Webview type
type Webview = { postMessage(msg: unknown): void } | undefined;
```

---

## 14. Adding New Features

### 14.1 Add a new tool animation

1. Add to `READING_TOOLS` set in `characters.ts` (reading anim) or it'll use typing (default)
2. Add display name to `formatToolStatus()` in `transcriptParser.ts`
3. Add to `STATUS_TO_TOOL` in `toolUtils.ts` if the label format differs
4. If exempt from permission timer: add to `PERMISSION_EXEMPT_TOOLS` in `transcriptParser.ts`

### 14.2 Add a new furniture type

1. Create PNG sprite(s) in `webview-ui/public/assets/furniture/`
2. Run the asset pipeline: `scripts/asset-manager.html` → set metadata → `5-export-assets.ts`
3. OR: manually add entry to `furniture-catalog.json`
4. Rebuild: `npm run build:electron`

Key catalog fields:
- `isDesk: true` → agents will animate toward it; surface items can be placed on it
- `canPlaceOnWalls: true` → wall-only placement (paintings, windows, etc.)
- `groupId` → links rotation/state variants together
- `backgroundTiles: N` → top N rows allow overlap (for tall furniture like bookshelves)

### 14.3 Add a new IPC message

1. **Backend → Frontend:** In `electron/main.ts` (or `PixelAgentsViewProvider.ts`), call `webview.postMessage({ type: 'myNew', ...payload })`
2. **Frontend handler:** In `useExtensionMessages.ts`, add `else if (msg.type === 'myNew')` branch
3. **Frontend → Backend:** Send via `vscode.postMessage({ type: 'myNew', ...payload })` (the `vscode` export from `vscodeApi.ts`)
4. **Backend handler:** In `electron/main.ts` `ipcMain.on('webview-message', ...)` handler, add case

### 14.4 Add a new persistent setting (Electron)

1. Add getter/setter to `electron/appState.ts` using `readJson` / `atomicWrite`
2. Send to webview in `handleWebviewReady()` in `electron/main.ts`
3. Handle `setSomething` message in the IPC handler

### 14.5 Add a new character palette

Six palettes are pre-colored in `char_0.png` … `char_5.png`. To add a 7th:
1. Edit `CHARACTER_PALETTES` in `scripts/export-characters.ts`
2. Re-run `tsx scripts/export-characters.ts`
3. Update `CHAR_COUNT = 7` in `src/constants.ts`
4. Rebuild

---

## 15. Known Issues & TODO

### 15.1 AppleScript terminal focus

`focusAgent` in Electron just calls `tell application "Terminal" to activate` — it brings Terminal.app to front but doesn't focus the specific window for that agent. To fix: track the Terminal.app tab/window by session ID using AppleScript.

### 15.2 Auto-detection on restore

After app restart, only sessions modified within 30 minutes are restored. Sessions older than 30 min are considered stale and dropped. Tune `RESTORE_LIVENESS_MS` in `agentManager.ts` if needed.

### 15.3 No Windows/Linux support

`terminalLauncher.ts` uses macOS-specific AppleScript. To add cross-platform support:
- Windows: use `wt.exe` (Windows Terminal) or `cmd.exe` via `child_process.spawn`
- Linux: detect `$TERMINAL` env var or try `xterm`, `gnome-terminal`, etc.

### 15.4 Floors.png missing from assets

The `floors.png` file may not be present in the bundled assets for some builds. If absent, floor tiles render as solid colors (fallback in `renderer.ts`). The file is generated by the asset pipeline scripts.

### 15.5 Furniture catalog missing in basic builds

`furniture-catalog.json` and furniture PNGs are optional. If absent, the office renders with only floor/wall tiles and character sprites — no furniture. Run the asset pipeline to generate furniture.
