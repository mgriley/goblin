// Module marker: keeps this file's top-level scope isolated (it's an ESM entry
// bundled by esbuild), so declarations don't collide with DOM globals like `status`.
export {}

import {
  type GoblinNode,
  type Recording,
  type RecordingEvent,
  type SliceKey,
  CATEGORY_COLORS,
  diffEntries,
  emptyGoblinState,
  lookup,
  replayTo,
  sliceEntries,
  topologyAt,
} from "../../shared/events"

// ---------------------------------------------------------------------------
// Tiny signal/effect reactive core
// ---------------------------------------------------------------------------
type Sub = () => void
let _current: Sub | null = null
interface Signal<T> { get(): T; set(v: T): void }

function signal<T>(val: T): Signal<T> {
  const subs = new Set<Sub>()
  return {
    get() { if (_current) subs.add(_current); return val },
    set(v) { val = v; subs.forEach(fn => fn()) },
  }
}
function effect(fn: () => void): void {
  const run: Sub = () => { _current = run; try { fn() } finally { _current = null } }
  run()
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const recording = signal<Recording | null>(null)
const index = signal(0)                       // current event (playhead)
const playing = signal(false)
const speed = signal(1)
const selected = signal<string>("")           // focused goblin id ("" = root)
const slice = signal<SliceKey>("notes")       // inspector subsystem tab
const status = signal<{ ok: boolean; text: string } | null>(null)
const tick = signal(0)                        // bumped on resize to force re-layout

const SLICES: SliceKey[] = ["notes", "db", "funcs", "libs", "interfaces", "peers", "ports"]

// ---------------------------------------------------------------------------
// DOM refs + helpers
// ---------------------------------------------------------------------------
const graphEl    = document.getElementById("graph")!
const eventCard  = document.getElementById("event-card")!
const goblinPanel = document.getElementById("goblin-panel")!
const timelineEl = document.getElementById("timeline")!
const fileEl     = document.getElementById("file")!
const metaEl     = document.getElementById("meta")!
const posEl      = document.getElementById("position")!
const statusEl   = document.getElementById("status")!
const playBtn    = document.getElementById("play") as HTMLButtonElement

function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
function trunc(s: string | undefined, n = 120): string {
  if (s == null) return ""
  return s.length > n ? s.slice(0, n) + "…" : s
}
function fmtTime(ts: string): string {
  const d = new Date(ts)
  return isNaN(d.getTime()) ? esc(ts) : d.toISOString().slice(11, 19)
}
const catColor = (cat: string): string => CATEGORY_COLORS[cat] ?? "#888"

/** The event at the playhead, or null when there are none. */
function curEvent(r: Recording): RecordingEvent | null {
  return r.events.length ? r.events[Math.min(index.get(), r.events.length - 1)] : null
}
/** Ordered goblin ids that get a timeline lane (baseline ∪ any event's goblin). */
function laneIds(r: Recording): string[] {
  const ids = new Set<string>((r.header?.goblins ?? []).map(g => g.id))
  for (const e of r.events) ids.add(e.goblinId)
  return [...ids].sort()
}

// ---------------------------------------------------------------------------
// Network graph (SVG)
// ---------------------------------------------------------------------------
interface Layout { pos: Map<string, { depth: number; x: number }>; leaves: number; maxDepth: number }

function computeLayout(nodes: GoblinNode[]): Layout {
  const ids = new Set(nodes.map(n => n.id))
  const childrenOf = new Map<string, string[]>()
  for (const n of nodes) {
    if (n.parentId !== null && ids.has(n.parentId)) {
      const arr = childrenOf.get(n.parentId) ?? []
      arr.push(n.id)
      childrenOf.set(n.parentId, arr)
    }
  }
  const roots = nodes.filter(n => n.parentId === null || !ids.has(n.parentId)).map(n => n.id).sort()
  const pos = new Map<string, { depth: number; x: number }>()
  let leaf = 0
  let maxDepth = 0
  const visit = (id: string, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth)
    const kids = (childrenOf.get(id) ?? []).sort()
    const x = kids.length
      ? (() => { const xs = kids.map(k => visit(k, depth + 1)); return (xs[0] + xs[xs.length - 1]) / 2 })()
      : leaf++
    pos.set(id, { depth, x })
    return x
  }
  roots.forEach(r => visit(r, 0))
  return { pos, leaves: Math.max(1, leaf), maxDepth }
}

function renderGraph(r: Recording): void {
  tick.get() // subscribe to resize
  const W = graphEl.clientWidth || 800
  const H = graphEl.clientHeight || 500
  const nodes = topologyAt(r.header, r.events, index.get())
  if (!nodes.length) { graphEl.innerHTML = '<div class="dim">No goblins</div>'; return }

  const { pos, leaves, maxDepth } = computeLayout(nodes)
  const padX = 70, padY = 55
  const px = (x: number) => padX + (leaves > 1 ? x / (leaves - 1) : 0.5) * (W - 2 * padX)
  const py = (d: number) => padY + (maxDepth > 0 ? d / maxDepth : 0.5) * (H - 2 * padY)

  const e = curEvent(r)
  const sel = selected.get()

  const edges = nodes
    .filter(n => n.parentId !== null && pos.has(n.parentId))
    .map(n => {
      const c = pos.get(n.id)!, p = pos.get(n.parentId!)!
      return `<line class="edge" x1="${px(p.x)}" y1="${py(p.depth)}" x2="${px(c.x)}" y2="${py(c.depth)}"/>`
    }).join("")

  const circles = nodes.map(n => {
    const p = pos.get(n.id)!
    const affected = e?.goblinId === n.id
    const cls = ["node", n.status === "exited" ? "exited" : "", n.id === sel ? "selected" : "", affected ? "affected" : ""].filter(Boolean).join(" ")
    return `<g class="${cls}" data-goblin="${esc(n.id)}" transform="translate(${px(p.x)},${py(p.depth)})">
        <circle class="ring" r="16" stroke="${affected && e ? catColor(e.category) : "transparent"}" stroke-width="2"/>
        <circle class="body" r="16" fill="#22303f" stroke="#4a6a8a" stroke-width="1.5"/>
        <text dy="32">${esc(n.name)}</text>
      </g>`
  }).join("")

  graphEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${edges}${circles}</svg>`
}

// ---------------------------------------------------------------------------
// Inspector: current-event card + selected-goblin state panel
// ---------------------------------------------------------------------------
type Diff = ReturnType<typeof diffEntries>[number]

function renderPanelEntry(d: Diff, touched: boolean): string {
  let v: string
  if (d.status === "changed") {
    v = `<span class="was">${esc(trunc(d.before))}</span><span class="arrow">→</span><span class="now">${esc(trunc(d.after))}</span>`
  } else if (d.status === "removed") {
    v = `<span class="was">${esc(trunc(d.before))}</span>`
  } else {
    v = `<span class="now">${esc(trunc(d.after ?? d.before))}</span>`
  }
  const cls = `entry ${d.status === "same" ? "" : d.status}${touched ? " touched" : ""}`.trim()
  return `<div class="${cls}"><span class="k">${esc(d.key)}</span><span class="v">${v}</span></div>`
}

function renderEventCard(r: Recording): void {
  const e = curEvent(r)
  if (!e) { eventCard.innerHTML = '<div class="dim">No events</div>'; return }
  const def = lookup(e)
  const label = def?.label ?? `${e.category} ${e.action}`
  const head = `<div class="ec-head">
      <span class="ec-cat" style="color:${catColor(e.category)}">${esc(e.category)}·<b>${esc(e.action)}</b></span>
      ${e.target ? `<span class="ec-target">${esc(e.target)}</span>` : ""}
      <span class="ec-seq">#${esc(e.seq)} · ${fmtTime(e.ts)}</span>
    </div>`

  let body = ""
  if (def?.slice) {
    const i = index.get()
    const before = sliceEntries(replayTo(r.header, r.events, i - 1)[e.goblinId] ?? emptyGoblinState(), def.slice)
    const after = sliceEntries(replayTo(r.header, r.events, i)[e.goblinId] ?? emptyGoblinState(), def.slice)
    const touched = diffEntries(before, after).find(d => d.key === e.target)
    body = touched
      ? renderPanelEntry(touched, true)
      : `<div class="dim">no persisted change (${esc(def.slice)})</div>`
  } else if (e.details) {
    body = `<pre class="dim" style="white-space:pre-wrap">${esc(JSON.stringify(e.details, null, 2))}</pre>`
  }
  eventCard.innerHTML = head + body
}

function renderGoblinPanel(r: Recording): void {
  const gid = selected.get()
  const i = index.get()
  const sk = slice.get()
  const after = replayTo(r.header, r.events, i)
  const before = replayTo(r.header, r.events, i - 1)
  const gAfter = after[gid] ?? emptyGoblinState()
  const gBefore = before[gid] ?? emptyGoblinState()

  const tabs = SLICES.map(s => {
    const n = Object.keys(sliceEntries(gAfter, s)).length
    return `<span class="tab${s === sk ? " active" : ""}" data-slice="${s}">${s}<span class="n">${n}</span></span>`
  }).join("")

  // Highlight the touched key only when the current event hit this goblin+slice.
  const e = curEvent(r)
  const touchKey = e && e.goblinId === gid && lookup(e)?.slice === sk ? e.target : null
  const diffs = diffEntries(sliceEntries(gBefore, sk), sliceEntries(gAfter, sk))
  const rows = diffs.length
    ? diffs.map(d => renderPanelEntry(d, d.key === touchKey)).join("")
    : `<div class="dim">(${esc(sk)} empty)</div>`

  goblinPanel.innerHTML = `<div class="gp-head">${esc(gid || "root")}</div>
    <div id="tabs">${tabs}</div>${rows}`
}

// ---------------------------------------------------------------------------
// Swimlane timeline (SVG)
// ---------------------------------------------------------------------------
const GUTTER = 96, RPAD = 16, LANE_H = 22, TOP = 8

function trackWidth(W: number): number { return Math.max(10, W - GUTTER - RPAD) }
function eventX(i: number, n: number, W: number): number {
  return GUTTER + (n > 1 ? i / (n - 1) : 0) * trackWidth(W)
}

function renderTimeline(r: Recording): void {
  tick.get()
  const W = timelineEl.clientWidth || 800
  const lanes = laneIds(r)
  const laneY = (gid: string) => TOP + lanes.indexOf(gid) * LANE_H + LANE_H / 2
  const H = TOP * 2 + lanes.length * LANE_H
  const n = r.events.length

  const bg = lanes.map((gid, li) => {
    const y = TOP + li * LANE_H
    return `<g><rect class="lane-bg" x="0" y="${y}" width="${W}" height="${LANE_H}"/>
        <text class="lane-label" x="8" y="${y + LANE_H / 2 + 4}">${esc(gid || "root")}</text>
        <line class="lane-sep" x1="0" y1="${y + LANE_H}" x2="${W}" y2="${y + LANE_H}"/></g>`
  }).join("")

  const cur = Math.min(index.get(), n - 1)
  const ticks = r.events.map((e, i) => {
    const cx = eventX(i, n, W)
    return `<circle class="tick" data-index="${i}" cx="${cx}" cy="${laneY(e.goblinId)}" r="${i === cur ? 5 : 3}" fill="${catColor(e.category)}"/>`
  }).join("")

  const hx = eventX(cur, n, W)
  const playhead = n
    ? `<line class="playhead" x1="${hx}" y1="0" x2="${hx}" y2="${H}"/>
       <path class="playhead-grip" d="M${hx - 5},0 L${hx + 5},0 L${hx},7 Z"/>`
    : ""

  timelineEl.innerHTML = `<svg width="${W}" height="${H}">${bg}${ticks}${playhead}</svg>`
}

// Scrub: map a client X to the nearest event index.
function scrubToClientX(clientX: number): void {
  const r = recording.get()
  if (!r || r.events.length === 0) return
  const rect = timelineEl.getBoundingClientRect()
  const frac = (clientX - rect.left - GUTTER) / trackWidth(rect.width)
  const i = Math.round(Math.max(0, Math.min(1, frac)) * (r.events.length - 1))
  index.set(i)
}

// ---------------------------------------------------------------------------
// Reactive wiring
// ---------------------------------------------------------------------------
effect(() => { const r = recording.get(); if (r) renderGraph(r); else graphEl.innerHTML = '<div class="dim">Loading…</div>' })
effect(() => { const r = recording.get(); if (r) renderEventCard(r) })
effect(() => { const r = recording.get(); if (r) renderGoblinPanel(r) })
effect(() => { const r = recording.get(); if (r) renderTimeline(r) })

effect(() => {
  const r = recording.get()
  if (!r) return
  fileEl.textContent = r.file ?? ""
  const parts: string[] = []
  if (r.header?.root) parts.push(r.header.root)
  parts.push(`${r.events.length} events`)
  metaEl.textContent = parts.join(" · ")
})

effect(() => {
  const r = recording.get()
  const n = r?.events.length ?? 0
  const i = Math.min(index.get(), Math.max(0, n - 1))
  const e = r && n ? r.events[i] : null
  posEl.textContent = n ? `#${i + 1} / ${n}${e ? "  " + fmtTime(e.ts) : ""}` : "—"
  playBtn.textContent = playing.get() ? "❚❚" : "▶"
})

effect(() => {
  const s = status.get()
  statusEl.textContent = s?.text ?? ""
  statusEl.className = s?.ok ? "live" : (s ? "error" : "")
})

// Playback loop — advance the playhead while playing.
let playTimer: ReturnType<typeof setInterval> | null = null
effect(() => {
  const p = playing.get()
  const sp = speed.get()
  if (playTimer) { clearInterval(playTimer); playTimer = null }
  if (!p) return
  playTimer = setInterval(() => {
    const r = recording.get()
    if (!r) return
    const n = r.events.length
    const cur = index.get()
    if (cur >= n - 1) { playing.set(false); return }
    index.set(cur + 1)
  }, 600 / sp)
})

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------
graphEl.addEventListener("click", e => {
  const g = (e.target as Element).closest<SVGGElement>(".node")
  if (g?.dataset.goblin !== undefined) selected.set(g.dataset.goblin)
})

goblinPanel.addEventListener("click", e => {
  const t = (e.target as HTMLElement).closest<HTMLElement>(".tab")
  if (t?.dataset.slice) slice.set(t.dataset.slice as SliceKey)
})

// Timeline scrubbing (click + drag).
let dragging = false
timelineEl.addEventListener("mousedown", e => { dragging = true; playing.set(false); scrubToClientX(e.clientX) })
window.addEventListener("mousemove", e => { if (dragging) scrubToClientX(e.clientX) })
window.addEventListener("mouseup", () => { dragging = false })

// Transport buttons.
document.getElementById("play")!.addEventListener("click", () => {
  const r = recording.get()
  if (!r || !r.events.length) return
  if (!playing.get() && index.get() >= r.events.length - 1) index.set(0) // replay from start
  playing.set(!playing.get())
})
document.getElementById("step-back")!.addEventListener("click", () => { playing.set(false); index.set(Math.max(0, index.get() - 1)) })
document.getElementById("step-fwd")!.addEventListener("click", () => {
  const r = recording.get()
  if (r) { playing.set(false); index.set(Math.min(r.events.length - 1, index.get() + 1)) }
})
document.getElementById("speed")!.addEventListener("change", e => speed.set(Number((e.target as HTMLSelectElement).value)))

window.addEventListener("resize", () => tick.set(tick.get() + 1))

// ---------------------------------------------------------------------------
// Data loading — poll the recording every 2s (reflects a growing recording)
// ---------------------------------------------------------------------------
let inited = false
async function fetchRecording(): Promise<void> {
  try {
    const res = await fetch("/recording")
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as Recording & { error?: string }
    if (data.error) throw new Error(data.error)
    recording.set(data)
    if (!inited && data.events.length) { index.set(data.events.length - 1); inited = true }
    status.set({ ok: true, text: "● Live" })
  } catch (e) {
    status.set({ ok: false, text: `⚠ ${(e as Error).message}` })
  }
}
fetchRecording()
setInterval(fetchRecording, 2000)
