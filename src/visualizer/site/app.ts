// Module marker: keeps this file's top-level scope isolated (it's an ESM entry
// bundled by esbuild), so declarations don't collide with DOM globals like `status`.
export {}

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

// Domain types (mirror the recording file shape; to be shared later)
interface RecEvent {
  type: 'event'
  goblinId: string
  ts: string
  seq: number
  category: string
  action: string
  target?: string
  details?: Record<string, unknown>
}

interface RecHeader {
  type: 'header'
  startedAt: string
  root: string
  goblins: { id: string; state: unknown }[]
}

interface Recording {
  file: string
  header: RecHeader | null
  events: RecEvent[]
}

interface Status {
  ok: boolean
  text: string
}

// State
const recording = signal<Recording | null>(null)
const status = signal<Status | null>(null)
const view = signal<'events'>('events') // more views to come

// DOM refs
const eventsView = document.getElementById('events-view')!
const fileEl     = document.getElementById('file')!
const metaEl     = document.getElementById('meta')!
const statusEl   = document.getElementById('status')!
const tabs       = document.querySelectorAll<HTMLElement>('.tab')

function esc(s: unknown): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// "2026-07-02T22:01:03.123Z" -> "22:01:03"
function fmtTime(ts: string): string {
  const d = new Date(ts)
  return isNaN(d.getTime()) ? esc(ts) : d.toISOString().slice(11, 19)
}

function renderEvent(e: RecEvent): string {
  const target = e.target ? `<span class="target">${esc(e.target)}</span>` : ''
  const details = e.details && Object.keys(e.details).length
    ? `<span class="details">  ${esc(JSON.stringify(e.details))}</span>` : ''
  return `<div class="event">
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
  if (!r) { eventsView.innerHTML = '<div class="dim">Loading…</div>'; return }
  const events = r.events ?? []
  eventsView.innerHTML = events.length
    ? events.map(renderEvent).join('')
    : '<div class="dim">No events in this recording</div>'
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
