// Module marker: keeps this file's top-level scope isolated (it's an ESM entry
// bundled by esbuild), so declarations don't collide with DOM globals like `status`.
export {}

import {
  type Recording,
  type RecordingEvent,
  CATEGORY_COLORS,
  diffEntries,
  emptyGoblinState,
  lookup,
  replayTo,
  sliceEntries,
} from "../../shared/events"

// Tiny signal/effect reactive core (shared shape with the inspector)
type Sub = () => void
let _current: Sub | null = null

interface Signal<T> {
  get(): T
  set(v: T): void
}

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

interface Status {
  ok: boolean
  text: string
}

// State
const recording = signal<Recording | null>(null)
const status = signal<Status | null>(null)
const view = signal<'events'>('events') // more views to come
const selected = signal<number | null>(null) // index into events

// DOM refs
const eventsView = document.getElementById('events-view')!
const detailEl   = document.getElementById('detail')!
const fileEl     = document.getElementById('file')!
const metaEl     = document.getElementById('meta')!
const statusEl   = document.getElementById('status')!
const tabs       = document.querySelectorAll<HTMLElement>('.tab')

function esc(s: unknown): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function trunc(s: string | undefined, n = 200): string {
  if (s == null) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

// "2026-07-02T22:01:03.123Z" -> "22:01:03"
function fmtTime(ts: string): string {
  const d = new Date(ts)
  return isNaN(d.getTime()) ? esc(ts) : d.toISOString().slice(11, 19)
}

function renderEvent(e: RecordingEvent, i: number, sel: number | null): string {
  const target = e.target ? `<span class="target">${esc(e.target)}</span>` : ''
  const details = e.details && Object.keys(e.details).length
    ? `<span class="details">  ${esc(JSON.stringify(e.details))}</span>` : ''
  return `<div class="event${i === sel ? ' selected' : ''}" data-index="${i}">
      <span class="seq">#${esc(e.seq)}</span>
      <span class="ts">${fmtTime(e.ts)}</span>
      <span class="goblin" title="${esc(e.goblinId || 'root')}">${esc(e.goblinId || 'root')}</span>
      <span class="cat">${esc(e.category)}·<span class="action">${esc(e.action)}</span></span>
      <span class="rest">${target}${details}</span>
    </div>`
}

// Render the events list
effect(() => {
  if (view.get() !== 'events') return
  const r = recording.get()
  const sel = selected.get()
  if (!r) { eventsView.innerHTML = '<div class="dim">Loading…</div>'; return }
  const events = r.events ?? []
  eventsView.innerHTML = events.length
    ? events.map((e, i) => renderEvent(e, i, sel)).join('')
    : '<div class="dim">No events in this recording</div>'
})

// Render one subsystem entry (a row in the before/after slice)
function renderEntry(d: ReturnType<typeof diffEntries>[number], touched: boolean): string {
  let v: string
  if (d.status === 'changed') {
    v = `<span class="was">${esc(trunc(d.before))}</span><span class="arrow">→</span><span class="now">${esc(trunc(d.after))}</span>`
  } else if (d.status === 'removed') {
    v = `<span class="was">${esc(trunc(d.before))}</span>`
  } else {
    v = `<span class="now">${esc(trunc(d.after ?? d.before))}</span>`
  }
  return `<div class="entry ${d.status}${touched ? ' touched' : ''}">
      <span class="k">${esc(d.key)}</span><span class="v">${v}</span>
    </div>`
}

// Render the detail pane for the selected event: its influence on the subsystem.
function renderDetail(r: Recording, index: number): string {
  const e = r.events[index]
  const def = lookup(e)
  const gid = e.goblinId || ''
  const color = CATEGORY_COLORS[e.category] ?? '#ccc'
  const label = def?.label ?? `${e.category} ${e.action}`
  const slice = def?.slice
  const head = `<div class="detail-head">
      <span class="d-goblin">${esc(gid || 'root')}</span>
      <span class="d-sub" style="color:${color}">${esc(slice ?? e.category)}</span>
      <span class="d-label">${esc(label)}${e.target ? ` <b>${esc(e.target)}</b>` : ''}</span>
    </div>`

  const before = replayTo(r.header, r.events, index - 1)
  const after = replayTo(r.header, r.events, index)
  const beforeSlice = slice ? sliceEntries(before[gid] ?? emptyGoblinState(), slice) : null
  const afterSlice  = slice ? sliceEntries(after[gid] ?? emptyGoblinState(), slice) : null

  // No slice view (spawn topology / goblin started) — show the raw payload.
  if (!beforeSlice || !afterSlice) {
    const json = e.details
      ? `<pre class="d-json">${esc(JSON.stringify(e.details, null, 2))}</pre>` : ''
    return head + `<div class="dim">No slice view for “${esc(slice ?? e.category)}” yet.</div>` + json
  }

  const diffs = diffEntries(beforeSlice, afterSlice)
  const rows = diffs.map(d => renderEntry(d, d.key === e.target)).join('')
  const body = diffs.length ? `<div class="slice">${rows}</div>` : '<div class="dim">(subsystem empty)</div>'
  return head + body
}

// Detail pane reacts to selection (and to new recording data)
effect(() => {
  const r = recording.get()
  const sel = selected.get()
  if (!r || sel === null || !r.events[sel]) {
    detailEl.innerHTML = '<div class="dim">Select an event to see its effect</div>'
    return
  }
  detailEl.innerHTML = renderDetail(r, sel)
})

// Header: file name + meta (root / started / event count)
effect(() => {
  const r = recording.get()
  if (!r) return
  fileEl.textContent = r.file ?? ''
  const parts: string[] = []
  if (r.header?.root) parts.push(r.header.root)
  if (r.header?.startedAt) parts.push(fmtTime(r.header.startedAt))
  parts.push(`${r.events?.length ?? 0} events`)
  metaEl.textContent = parts.join(' · ')
})

// Tab active state
effect(() => {
  const v = view.get()
  tabs.forEach(t => t.classList.toggle('active', t.dataset.view === v))
})

// Status chip
effect(() => {
  const s = status.get()
  statusEl.textContent = s?.text ?? ''
  statusEl.className = s?.ok ? 'live' : (s ? 'error' : '')
})

tabs.forEach(t => t.addEventListener('click', () => view.set(t.dataset.view as 'events')))

// Select an event to inspect its effect
eventsView.addEventListener('click', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.event')
  const idx = row?.dataset.index
  if (idx === undefined) return
  selected.set(Number(idx))
})

// Poll the recording every 2s (reflects a still-growing recording live)
async function fetchRecording(): Promise<void> {
  try {
    const res = await fetch('/recording')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as Recording & { error?: string }
    if (data.error) throw new Error(data.error)
    recording.set(data)
    status.set({ ok: true, text: '● Live' })
  } catch (e) {
    status.set({ ok: false, text: `⚠ ${(e as Error).message}` })
  }
}

fetchRecording()
setInterval(fetchRecording, 2000)
