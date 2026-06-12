# Recording & Visualizer

> **Note:** This document was written by Claude (the AI assistant), capturing a
> design agreed with the user. It describes planned work that is not yet
> implemented.

## Goal

Collect and combine the `event_log` files from every goblin (the root and all
children, recursively) into a single "recording", then replay that recording in
a separate **visualizer** SPA — a timeline you can step back and forth through to
see exactly what the network was doing, event by event, with full per-goblin
state at each step.

## Decisions

- **Self-contained events.** Each event carries its own payload (e.g. a `func`
  change embeds the new code), so the recording is pure event-sourcing: the
  visualizer reconstructs state by replaying events, with no file re-reads and no
  races.
- **Byte-capped large payloads.** Keep only the first `X` bytes of large payloads
  (e.g. function bodies), flagged `truncated: true`. Simple; lossy for big
  content.
- **Explicit record button.** The inspector has a Record / Stop toggle that bounds
  one recording, rather than capturing continuously.
- **Full per-goblin state replay.** The visualizer reconstructs each goblin's
  full state (notes, funcs, db, peers, ports) at any point on the timeline.

## Data model

**Structured event** — one JSON line in each goblin's `event_log.jsonl`:

```json
{ "ts": "2026-…", "seq": 42, "category": "func", "action": "modified",
  "target": "handleRequest_main", "details": { "code": "…", "truncated": true } }
```

- `goblinId` is **not** stored per-goblin — the recorder stamps it from the
  file's directory path on merge (`""` = root, `children/foo`, …), which also
  encodes the tree structure for free.
- `seq` is a per-goblin monotonic counter. On `Logger.init` we seed it from the
  last line of the existing `.jsonl` so it stays monotonic across restarts; this
  lets the recorder tail by `seq > cursor` and detect gaps.
- Payload truncation is centralized in the Logger: any string in `details` over
  `MAX_PAYLOAD_BYTES` (~4KB) is sliced and flagged `truncated: true`. Call sites
  stay dumb.

**Human `event_log.txt` — unchanged in spirit.** Still derived as
`[category] action "target"`, never carries payloads, so it stays tiny and fast.

## Phase 1 — Logger → structured-first (foundation)

- `src/utils/logger.ts`: `logEvent(message: string)` →
  `logEvent(e: { category, action, target?, details? })`. Writes both files;
  derives the `.txt` line; truncates oversized `details` strings; maintains and
  seeds `seq`.
- Refactor the ~26 call sites (`goblin.ts`, `database.ts`, `notes_manager.ts`,
  `function_manager.ts`, `peer_manager.ts`, `ports_manager.ts`,
  `spawn_manager.ts`) to pass structured events. The state-bearing ones attach
  payloads: `func created/modified → { code }`, `notes set → { content }`,
  `db set → { value }`, `port opened → { host, port }`,
  `spawn exited → { reason }`.
- **Checkpoint:** `.txt` output looks identical to today; `.jsonl` appears
  alongside.

## Phase 2 — Recorder + record button (in the inspector)

- `src/inspector/recorder.ts`:
  - **Start**: walk root + `children/**`, capture a **baseline state snapshot**
    of every live goblin (notes, funcs/interfaces/libs, db, peers, ports,
    purpose) — this is what makes full-state replay work when you start recording
    mid-session. Write it as the recording's header frame.
  - **Tail loop** (~1s poll): for each goblin read `event_log.jsonl`, append
    events with `seq > cursor`, stamp `goblinId`, write to
    `recordings/<timestamp>.jsonl`; rescan for newly-spawned goblin dirs.
  - **Stop**: finalize, stop polling.
- `src/inspector/server.ts`: `POST /record/start`, `POST /record/stop`,
  `GET /record/status`.
- Inspector header: a **● Record / ■ Stop** toggle showing elapsed time + event
  count.
- Recording file shape: line 0
  `{ type: "header", startedAt, root, goblins: [{ id, state }] }`, then
  `{ type: "event", … }` lines.

## Phase 3 — Visualizer (its own SPA)

- `src/visualizer/{main.ts, server.ts, site/{index.html, app.js}}`, mirroring the
  inspector. Launched separately, pointed at a recording file (argv); serves the
  SPA + `GET /recording`.
- **Reducer**: baseline header + events `0..i` → network state. Each
  `(category, action)` maps to a mutation (`spawn spawned` → add node,
  `peer attached` → add edge, `port opened` → add port, `notes set` → update
  note, `func modified` → update code, …).
- **UI**: timeline scrubber + ◀ ▶ step (recompute-from-zero on seek), an SVG
  node-link graph laid out by `goblinId` nesting (nodes appear/disappear over
  time, peer edges, ports), a selected-goblin panel showing notes/funcs/db **at
  that step**, and a current-event detail pane.
- `package.json`: add `cp -r src/visualizer/site dist/visualizer/site` and a
  `visualize` script.

## Build order rationale

Each phase is independently verifiable: Phase 1 changes nothing observable except
a new `.jsonl`; Phase 2 produces a recording you can `cat`; Phase 3 consumes it.
We checkpoint between each.

## Notes / minor decisions

- Recordings go to `<rootDir>/recordings/<timestamp>.jsonl` so multiple takes
  don't clobber and they sit naturally inside the inspectable tree.
- Write performance is not a concern: the Logger is async, serialized through a
  promise queue, and fire-and-forget, so even large payloads never block the
  agent loop.
