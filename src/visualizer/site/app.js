// src/visualizer/site/app.ts
var _current = null;
function signal(val) {
  const subs = /* @__PURE__ */ new Set();
  return {
    get() {
      if (_current) subs.add(_current);
      return val;
    },
    set(v) {
      val = v;
      subs.forEach((fn) => fn());
    }
  };
}
function effect(fn) {
  const run = () => {
    _current = run;
    try {
      fn();
    } finally {
      _current = null;
    }
  };
  run();
}
var recording = signal(null);
var status = signal(null);
var view = signal("events");
var eventsView = document.getElementById("events-view");
var fileEl = document.getElementById("file");
var metaEl = document.getElementById("meta");
var statusEl = document.getElementById("status");
var tabs = document.querySelectorAll(".tab");
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtTime(ts) {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? esc(ts) : d.toISOString().slice(11, 19);
}
function renderEvent(e) {
  const target = e.target ? `<span class="target">${esc(e.target)}</span>` : "";
  const details = e.details && Object.keys(e.details).length ? `<span class="details">  ${esc(JSON.stringify(e.details))}</span>` : "";
  return `<div class="event">
      <span class="seq">#${esc(e.seq)}</span>
      <span class="ts">${fmtTime(e.ts)}</span>
      <span class="goblin" title="${esc(e.goblinId || "root")}">${esc(e.goblinId || "root")}</span>
      <span class="cat">${esc(e.category)}\xB7<span class="action">${esc(e.action)}</span></span>
      <span class="rest">${target}${details}</span>
    </div>`;
}
effect(() => {
  if (view.get() !== "events") return;
  const r = recording.get();
  if (!r) {
    eventsView.innerHTML = '<div class="dim">Loading\u2026</div>';
    return;
  }
  const events = r.events ?? [];
  eventsView.innerHTML = events.length ? events.map(renderEvent).join("") : '<div class="dim">No events in this recording</div>';
});
effect(() => {
  const r = recording.get();
  if (!r) return;
  fileEl.textContent = r.file ?? "";
  const parts = [];
  if (r.header?.root) parts.push(r.header.root);
  if (r.header?.startedAt) parts.push(fmtTime(r.header.startedAt));
  parts.push(`${r.events?.length ?? 0} events`);
  metaEl.textContent = parts.join(" \xB7 ");
});
effect(() => {
  const v = view.get();
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.view === v));
});
effect(() => {
  const s = status.get();
  statusEl.textContent = s?.text ?? "";
  statusEl.className = s?.ok ? "live" : s ? "error" : "";
});
tabs.forEach((t) => t.addEventListener("click", () => view.set(t.dataset.view)));
async function fetchRecording() {
  try {
    const res = await fetch("/recording");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    recording.set(data);
    status.set({ ok: true, text: "\u25CF Live" });
  } catch (e) {
    status.set({ ok: false, text: `\u26A0 ${e.message}` });
  }
}
fetchRecording();
setInterval(fetchRecording, 2e3);
