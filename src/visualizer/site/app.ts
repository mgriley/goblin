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

const SLICES: SliceKey[] = ["notes", "db", "funcs", "libs", "interfaces", "peers", "ports"]

/** Per-subsystem accent, so anatomy regions read like the rest of the UI. The
 *  func family (funcs/libs/interfaces) shares category "func" but gets distinct
 *  blue tints here so the three regions stay visually separable. */
const SLICE_COLORS: Record<SliceKey, string> = {
  notes: CATEGORY_COLORS.notes,
  db: CATEGORY_COLORS.database,
  funcs: CATEGORY_COLORS.func,
  libs: "#4a7ab0",
  interfaces: "#7fb0e0",
  peers: CATEGORY_COLORS.peer,
  ports: CATEGORY_COLORS.port,
}

// ---------------------------------------------------------------------------
// DOM refs + helpers
// ---------------------------------------------------------------------------
const graphEl    = document.getElementById("graph")!
const eventLog   = document.getElementById("event-log")!
const eventCard  = document.getElementById("event-card")!
const goblinPanel = document.getElementById("goblin-panel")!
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
/** Short display name for a goblin id (`""`→root, `children/foo`→foo). */
function shortGoblin(id: string): string {
  return id === "" ? "root" : id.split("/").pop()!
}

// ---------------------------------------------------------------------------
// Anatomy view — every live goblin as a card of colour-coded subsystem regions,
// each holding its entries as tiles. The entry touched by the current event
// pulses in its subsystem colour, so it tracks playback. Cards indent by depth
// so the parent→child topology still reads at a glance.
// ---------------------------------------------------------------------------
/** Nesting depth of a goblin id (root = 0, each `/children/` adds one). */
function goblinDepth(id: string): number {
  return id === "" ? 0 : (id.match(/children\//g) ?? []).length
}

function renderGoblinCard(n: GoblinNode, r: Recording, net: ReturnType<typeof replayTo>): string {
  const state = net[n.id] ?? emptyGoblinState()
  const e = curEvent(r)
  const touchSlice = e && e.goblinId === n.id ? lookup(e)?.slice ?? null : null
  const touchKey = touchSlice ? e!.target ?? null : null

  const regions = SLICES.map(sk => {
    const entries = sliceEntries(state, sk)
    const keys = Object.keys(entries).sort()
    const tiles = keys.map(k => {
      const touched = sk === touchSlice && k === touchKey
      return `<div class="tile${touched ? " touched" : ""}" data-slice="${sk}" title="${esc(trunc(entries[k], 240))}">${esc(k)}</div>`
    }).join("")
    return `<div class="region${keys.length ? "" : " empty"}${sk === touchSlice ? " active" : ""}" style="--c:${SLICE_COLORS[sk]}" data-slice="${sk}">
        <div class="region-head"><span class="dot"></span>${sk}<span class="rn">${keys.length}</span></div>
        ${keys.length ? `<div class="tiles">${tiles}</div>` : ""}
      </div>`
  }).join("")

  const affected = e?.goblinId === n.id
  const cls = ["gcard", n.status === "exited" ? "exited" : "", n.id === selected.get() ? "selected" : "", affected ? "affected" : ""].filter(Boolean).join(" ")
  const styles = [`margin-left:${goblinDepth(n.id) * 18}px`]
  if (affected && e) styles.push(`--ec:${catColor(e.category)}`)
  return `<div class="${cls}" data-goblin="${esc(n.id)}" style="${styles.join(";")}">
      <div class="gcard-head">
        <span class="gc-name">${esc(n.name)}</span>
        ${n.parentId !== null ? `<span class="gc-parent">◂ ${esc(shortGoblin(n.parentId))}</span>` : ""}
        ${n.status === "exited" ? `<span class="gc-exited">exited</span>` : ""}
      </div>
      <div class="regions">${regions}</div>
    </div>`
}

function renderAnatomy(r: Recording): void {
  const nodes = topologyAt(r.header, r.events, index.get()).sort((a, b) => a.id.localeCompare(b.id))
  if (!nodes.length) { graphEl.innerHTML = '<div class="dim">No goblins</div>'; return }
  const net = replayTo(r.header, r.events, index.get())
  graphEl.innerHTML = `<div class="anatomy">${nodes.map(n => renderGoblinCard(n, r, net)).join("")}</div>`
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
// Event log (left) — the primary navigator
// ---------------------------------------------------------------------------
function buildLog(r: Recording): void {
  eventLog.innerHTML = r.events.length
    ? r.events.map((e, i) => `<div class="log-row" data-index="${i}">
        <span class="l-seq">${i + 1}</span>
        <span class="l-gob" title="${esc(e.goblinId || "root")}">${esc(shortGoblin(e.goblinId))}</span>
        <span class="l-act" style="color:${catColor(e.category)}">${esc(e.category)}·${esc(e.action)}</span>
        <span class="l-tgt">${e.target ? esc(e.target) : ""}</span>
      </div>`).join("")
    : '<div class="dim">No events</div>'
}

/** Move the active highlight to the current event and scroll it into view. */
function highlightLog(r: Recording): void {
  if (!r.events.length) return
  const cur = Math.min(index.get(), r.events.length - 1)
  eventLog.querySelector(".log-row.active")?.classList.remove("active")
  const row = eventLog.querySelector<HTMLElement>(`.log-row[data-index="${cur}"]`)
  if (row) { row.classList.add("active"); row.scrollIntoView({ block: "nearest" }) }
}

// ---------------------------------------------------------------------------
// Reactive wiring
// ---------------------------------------------------------------------------
effect(() => {
  const r = recording.get()
  if (!r) { graphEl.innerHTML = '<div class="dim">Loading…</div>'; return }
  renderAnatomy(r)
})
effect(() => { const r = recording.get(); if (r) renderEventCard(r) })
effect(() => { const r = recording.get(); if (r) renderGoblinPanel(r) })
effect(() => { const r = recording.get(); if (r) buildLog(r) })       // list structure (on recording change)
effect(() => { const r = recording.get(); if (r) highlightLog(r) })   // active row + autoscroll (on index change)

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
// Anatomy view: click a goblin card to focus it in the inspector; clicking a
// subsystem region also opens that slice tab.
graphEl.addEventListener("click", e => {
  const t = e.target as Element
  const card = t.closest<HTMLElement>("[data-goblin]")
  if (card?.dataset.goblin === undefined) return
  selected.set(card.dataset.goblin)
  const region = t.closest<HTMLElement>("[data-slice]")
  if (region?.dataset.slice) slice.set(region.dataset.slice as SliceKey)
})

goblinPanel.addEventListener("click", e => {
  const t = (e.target as HTMLElement).closest<HTMLElement>(".tab")
  if (t?.dataset.slice) slice.set(t.dataset.slice as SliceKey)
})

// Event log — click a row to jump the playhead there.
eventLog.addEventListener("click", e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".log-row")
  if (row?.dataset.index !== undefined) { playing.set(false); index.set(Number(row.dataset.index)) }
})

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
