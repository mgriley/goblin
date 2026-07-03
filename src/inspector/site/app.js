// Tiny signal/effect reactive core
let _current = null

function signal(val) {
  const subs = new Set()
  return {
    get() { if (_current) subs.add(_current); return val },
    set(v) { val = v; subs.forEach(fn => fn()) },
  }
}

function effect(fn) {
  const run = () => { _current = run; try { fn() } finally { _current = null } }
  run()
}

// State
const tree = signal(null)
const selectedPath = signal(null)
const expanded = signal(new Set([''])) // root open by default
const status = signal(null)            // null | { ok: bool, text: string }
const view = signal('files')           // 'files' | 'chat'
const messages = signal([])            // [{ role: 'user'|'agent', text, state? }]
const sending = signal(false)
const rec = signal({ recording: false, startedAt: null, events: 0 })

// Find a node by path in the tree
function findNode(node, target) {
  if (node.path === target) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, target)
    if (found) return found
  }
  return null
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function formatContent(node) {
  if (!node.content) return '(empty)'
  if (node.name.endsWith('.json')) {
    try { return JSON.stringify(JSON.parse(node.content), null, 2) } catch {}
  }
  return node.content
}

// Build HTML for one tree node (recursive)
function renderNode(node, depth = 0) {
  const pad = `padding-left:${depth * 14 + 8}px`

  if (node.type === 'dir') {
    const open = expanded.get().has(node.path)
    const kids = open && node.children
      ? node.children.map(c => renderNode(c, depth + 1)).join('') : ''
    return `<div class="row dir" data-action="toggle" data-path="${esc(node.path)}" style="${pad}">
        <span class="chevron">${open ? '▾' : '▸'}</span><span class="name">${esc(node.name)}</span>
      </div>${kids}`
  }

  const sel = selectedPath.get() === node.path ? ' selected' : ''
  return `<div class="row file${sel}" data-action="select" data-path="${esc(node.path)}" style="${pad}">
      <span class="chevron">·</span><span class="name">${esc(node.name)}</span>
    </div>`
}

// DOM refs
const sidebar   = document.getElementById('sidebar')
const filesView = document.getElementById('files-view')
const chatView  = document.getElementById('chat-view')
const statusEl  = document.getElementById('status')
const messagesEl = document.getElementById('messages')
const chatInput = document.getElementById('chat-input')
const chatSend  = document.getElementById('chat-send')
const tabs      = document.querySelectorAll('.tab')
const recordBtn = document.getElementById('record')

// Re-render sidebar when tree, selection, or expanded state changes
effect(() => {
  const t = tree.get()
  selectedPath.get() // subscribe
  expanded.get()     // subscribe
  sidebar.innerHTML = t ? renderNode(t) : '<div class="dim">Loading…</div>'
})

// Re-render file content when selection or tree changes
effect(() => {
  const t = tree.get()
  const p = selectedPath.get()
  if (!t || !p) { filesView.innerHTML = '<div class="dim">Select a file to inspect</div>'; return }
  const node = findNode(t, p)
  if (!node) { filesView.innerHTML = '<div class="dim">File not found</div>'; return }
  filesView.innerHTML = `<div id="file-path">${esc(node.path)}</div><pre id="file-body">${esc(formatContent(node))}</pre>`
})

// Toggle between Files and Chat views
effect(() => {
  const v = view.get()
  sidebar.style.display   = v === 'files' ? '' : 'none'
  filesView.style.display = v === 'files' ? '' : 'none'
  chatView.style.display  = v === 'chat'  ? 'flex' : 'none'
  tabs.forEach(t => t.classList.toggle('active', t.dataset.view === v))
  if (v === 'chat') chatInput.focus()
})

// Render chat messages
effect(() => {
  const msgs = messages.get()
  messagesEl.innerHTML = msgs.length
    ? msgs.map(m => `<div class="msg ${m.role}${m.state ? ' ' + m.state : ''}">${esc(m.text)}</div>`).join('')
    : '<div class="dim">Send a message to the agent</div>'
  messagesEl.scrollTop = messagesEl.scrollHeight
})

// Reflect send-in-progress on the composer
effect(() => {
  const busy = sending.get()
  chatSend.disabled = busy
  chatSend.textContent = busy ? '…' : 'Send'
})

// Render the record button (label + elapsed + event count)
function fmtElapsed(startedAt) {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(startedAt)) / 1000))
  const m = String(Math.floor(secs / 60)).padStart(2, '0')
  const s = String(secs % 60).padStart(2, '0')
  return `${m}:${s}`
}
effect(() => {
  const r = rec.get()
  recordBtn.classList.toggle('recording', r.recording)
  recordBtn.textContent = r.recording
    ? `■ Stop  ${fmtElapsed(r.startedAt)} · ${r.events} ev`
    : '● Record'
})

// Update status chip
effect(() => {
  const s = status.get()
  statusEl.textContent = s?.text ?? ''
  statusEl.className   = s?.ok ? 'live' : (s ? 'error' : '')
})

// Sidebar click delegation: toggle dirs, select files
sidebar.addEventListener('click', e => {
  const row = e.target.closest('[data-action]')
  if (!row) return
  const { action, path } = row.dataset
  if (action === 'toggle') {
    const exp = expanded.get()
    exp.has(path) ? exp.delete(path) : exp.add(path)
    expanded.set(exp)
  } else if (action === 'select') {
    selectedPath.set(path)
  }
})

// Tab switching
tabs.forEach(t => t.addEventListener('click', () => view.set(t.dataset.view)))

// Record / Stop toggle
recordBtn.addEventListener('click', async () => {
  recordBtn.disabled = true
  try {
    const action = rec.get().recording ? '/record/stop' : '/record/start'
    const res = await fetch(action, { method: 'POST' })
    rec.set(await res.json())
  } catch (e) {
    status.set({ ok: false, text: `⚠ ${e.message}` })
  } finally {
    recordBtn.disabled = false
  }
})

// Poll record status every 1s (keeps the live event count + elapsed fresh)
async function fetchRecordStatus() {
  try {
    const res = await fetch('/record/status')
    if (res.ok) rec.set(await res.json())
  } catch { /* inspector momentarily unreachable — ignore */ }
}
fetchRecordStatus()
setInterval(fetchRecordStatus, 1000)

// Send a chat message to the agent (via the inspector's /ask proxy)
async function sendMessage() {
  const text = chatInput.value.trim()
  if (!text || sending.get()) return

  messages.set([...messages.get(), { role: 'user', text }])
  chatInput.value = ''
  autoGrow()
  sending.set(true)

  // Optimistic pending bubble; replaced when the reply (or error) arrives.
  const pending = { role: 'agent', text: 'thinking…', state: 'pending' }
  messages.set([...messages.get(), pending])

  try {
    const res = await fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    pending.text = data.response ?? '(no response)'
    pending.state = undefined
  } catch (e) {
    pending.text = `⚠ ${e.message}`
    pending.state = 'error'
  } finally {
    messages.set([...messages.get()]) // re-render with the resolved bubble
    sending.set(false)
    chatInput.focus()
  }
}

// Enter sends, Shift+Enter inserts a newline
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
})
chatInput.addEventListener('input', autoGrow)
chatSend.addEventListener('click', sendMessage)

function autoGrow() {
  chatInput.style.height = 'auto'
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px'
}

// Poll /tree every 3 s
async function fetchTree() {
  try {
    const res = await fetch('/tree')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    tree.set(await res.json())
    status.set({ ok: true, text: '● Live' })
  } catch (e) {
    status.set({ ok: false, text: `⚠ ${e.message}` })
  }
}

fetchTree()
setInterval(fetchTree, 3000)
