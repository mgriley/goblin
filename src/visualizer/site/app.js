// src/shared/events.ts
function emptyGoblinState() {
  return { notes: {}, db: {}, funcs: {}, libs: {}, interfaces: {}, peers: {}, ports: {} };
}
function def(label, slice, reduce) {
  return { label, slice, reduce };
}
function withKey(rec, k, v) {
  return { ...rec, [k]: v };
}
function withoutKey(rec, k) {
  const out = { ...rec };
  delete out[k];
  return out;
}
var REGISTRY = {
  // goblin lifecycle. Purpose is the `Purpose` note, so it writes the notes slice
  // (it's the only purpose signal on a restart where no `notes/set` fires).
  "goblin/started": def("started"),
  "goblin/purpose": def("purpose set", "notes", (s, e) => ({
    ...s,
    notes: withKey(s.notes, "Purpose", e.details.purpose)
  })),
  // key/value database
  "database/set": def("set", "db", (s, e) => ({
    ...s,
    db: withKey(s.db, e.target, e.details.value)
  })),
  "database/deleted": def("deleted", "db", (s, e) => ({ ...s, db: withoutKey(s.db, e.target) })),
  // notes
  "notes/set": def("set", "notes", (s, e) => ({
    ...s,
    notes: withKey(s.notes, e.target, e.details.content)
  })),
  "notes/deleted": def("deleted", "notes", (s, e) => ({ ...s, notes: withoutKey(s.notes, e.target) })),
  // functions (code + which libs they share)
  "func/created": def("created func", "funcs", (s, e) => ({
    ...s,
    funcs: withKey(s.funcs, e.target, { code: e.details.code, sharedLibs: s.funcs[e.target]?.sharedLibs ?? [] })
  })),
  "func/modified": def("modified func", "funcs", (s, e) => ({
    ...s,
    funcs: withKey(s.funcs, e.target, { code: e.details.code, sharedLibs: s.funcs[e.target]?.sharedLibs ?? [] })
  })),
  "func/removed": def("removed func", "funcs", (s, e) => ({ ...s, funcs: withoutKey(s.funcs, e.target) })),
  // shared libs
  "func/created lib": def("created lib", "libs", (s, e) => ({
    ...s,
    libs: withKey(s.libs, e.target, e.details.code)
  })),
  "func/modified lib": def("modified lib", "libs", (s, e) => ({
    ...s,
    libs: withKey(s.libs, e.target, e.details.code)
  })),
  "func/removed lib": def("removed lib", "libs", (s, e) => ({ ...s, libs: withoutKey(s.libs, e.target) })),
  // interfaces (named sets of exposed funcs)
  "func/created interface": def("created interface", "interfaces", (s, e) => ({
    ...s,
    interfaces: withKey(s.interfaces, e.target, e.details.funcs)
  })),
  "func/modified interface": def("modified interface", "interfaces", (s, e) => ({
    ...s,
    interfaces: withKey(s.interfaces, e.target, e.details.funcs)
  })),
  "func/removed interface": def("removed interface", "interfaces", (s, e) => ({
    ...s,
    interfaces: withoutKey(s.interfaces, e.target)
  })),
  // ports. `closed` keeps the persisted record (transient) — slice, no reduce.
  "port/opened": def("opened", "ports", (s, e) => ({
    ...s,
    ports: withKey(s.ports, e.target, { host: e.details.host, port: e.details.port })
  })),
  "port/closed": def("closed", "ports"),
  "port/removed": def("removed", "ports", (s, e) => ({ ...s, ports: withoutKey(s.ports, e.target) })),
  // peers. `connected`/`detached` keep the persisted binding (transient).
  "peer/attached": def("attached", "peers", (s, e) => ({ ...s, peers: withKey(s.peers, e.target, null) })),
  "peer/connected": def("connected", "peers"),
  "peer/detached": def("detached", "peers"),
  "peer/removed": def("removed", "peers", (s, e) => ({ ...s, peers: withoutKey(s.peers, e.target) })),
  "peer/set interface": def("set interface", "peers", (s, e) => ({
    ...s,
    peers: withKey(s.peers, e.target, e.details.interface)
  })),
  "peer/cleared interface": def("cleared interface", "peers", (s, e) => ({
    ...s,
    peers: withKey(s.peers, e.target, null)
  })),
  // spawning child goblins — topology, not a slice of this goblin's state.
  "spawn/spawned": def("spawned"),
  "spawn/removed": def("removed"),
  "spawn/exited": def("exited")
};
function lookup(e) {
  return REGISTRY[`${e.category}/${e.action}`];
}
var CATEGORY_COLORS = {
  goblin: "#c586c0",
  database: "#4ec9b0",
  notes: "#dcdcaa",
  func: "#569cd6",
  port: "#ce9178",
  peer: "#4fc1ff",
  spawn: "#b5cea8"
};
function baselineState(header) {
  const out = {};
  for (const g of header?.goblins ?? []) out[g.id] = g.state;
  return out;
}
function applyEvent(state, e) {
  const d = REGISTRY[`${e.category}/${e.action}`];
  if (!d?.reduce) return state;
  const g = state[e.goblinId] ?? emptyGoblinState();
  return { ...state, [e.goblinId]: d.reduce(g, e) };
}
function replayTo(header, events, index) {
  let state = baselineState(header);
  const end = Math.min(index, events.length - 1);
  for (let i = 0; i <= end; i++) state = applyEvent(state, events[i]);
  return state;
}
function mapValues(rec, f) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) out[k] = f(v);
  return out;
}
function sliceEntries(g, slice) {
  switch (slice) {
    case "notes":
      return g.notes;
    case "db":
      return g.db;
    case "libs":
      return g.libs;
    case "funcs":
      return mapValues(g.funcs, (f) => f.code);
    case "interfaces":
      return mapValues(g.interfaces, (fs) => fs.join(", "));
    case "peers":
      return mapValues(g.peers, (p) => p ?? "(no interface)");
    case "ports":
      return mapValues(g.ports, (p) => `${p.host}:${p.port}`);
  }
}
function diffEntries(before, after) {
  const keys = [.../* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.map((key) => {
    const b = before[key];
    const a = after[key];
    const status2 = b === void 0 ? "added" : a === void 0 ? "removed" : b !== a ? "changed" : "same";
    return { key, before: b, after: a, status: status2 };
  });
}

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
var selected = signal(null);
var eventsView = document.getElementById("events-view");
var detailEl = document.getElementById("detail");
var fileEl = document.getElementById("file");
var metaEl = document.getElementById("meta");
var statusEl = document.getElementById("status");
var tabs = document.querySelectorAll(".tab");
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function trunc(s, n = 200) {
  if (s == null) return "";
  return s.length > n ? s.slice(0, n) + "\u2026" : s;
}
function fmtTime(ts) {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? esc(ts) : d.toISOString().slice(11, 19);
}
function renderEvent(e, i, sel) {
  const target = e.target ? `<span class="target">${esc(e.target)}</span>` : "";
  const details = e.details && Object.keys(e.details).length ? `<span class="details">  ${esc(JSON.stringify(e.details))}</span>` : "";
  return `<div class="event${i === sel ? " selected" : ""}" data-index="${i}">
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
  const sel = selected.get();
  if (!r) {
    eventsView.innerHTML = '<div class="dim">Loading\u2026</div>';
    return;
  }
  const events = r.events ?? [];
  eventsView.innerHTML = events.length ? events.map((e, i) => renderEvent(e, i, sel)).join("") : '<div class="dim">No events in this recording</div>';
});
function renderEntry(d, touched) {
  let v;
  if (d.status === "changed") {
    v = `<span class="was">${esc(trunc(d.before))}</span><span class="arrow">\u2192</span><span class="now">${esc(trunc(d.after))}</span>`;
  } else if (d.status === "removed") {
    v = `<span class="was">${esc(trunc(d.before))}</span>`;
  } else {
    v = `<span class="now">${esc(trunc(d.after ?? d.before))}</span>`;
  }
  return `<div class="entry ${d.status}${touched ? " touched" : ""}">
      <span class="k">${esc(d.key)}</span><span class="v">${v}</span>
    </div>`;
}
function renderDetail(r, index) {
  const e = r.events[index];
  const def2 = lookup(e);
  const gid = e.goblinId || "";
  const color = CATEGORY_COLORS[e.category] ?? "#ccc";
  const label = def2?.label ?? `${e.category} ${e.action}`;
  const slice = def2?.slice;
  const head = `<div class="detail-head">
      <span class="d-goblin">${esc(gid || "root")}</span>
      <span class="d-sub" style="color:${color}">${esc(slice ?? e.category)}</span>
      <span class="d-label">${esc(label)}${e.target ? ` <b>${esc(e.target)}</b>` : ""}</span>
    </div>`;
  const before = replayTo(r.header, r.events, index - 1);
  const after = replayTo(r.header, r.events, index);
  const beforeSlice = slice ? sliceEntries(before[gid] ?? emptyGoblinState(), slice) : null;
  const afterSlice = slice ? sliceEntries(after[gid] ?? emptyGoblinState(), slice) : null;
  if (!beforeSlice || !afterSlice) {
    const json = e.details ? `<pre class="d-json">${esc(JSON.stringify(e.details, null, 2))}</pre>` : "";
    return head + `<div class="dim">No slice view for \u201C${esc(slice ?? e.category)}\u201D yet.</div>` + json;
  }
  const diffs = diffEntries(beforeSlice, afterSlice);
  const rows = diffs.map((d) => renderEntry(d, d.key === e.target)).join("");
  const body = diffs.length ? `<div class="slice">${rows}</div>` : '<div class="dim">(subsystem empty)</div>';
  return head + body;
}
effect(() => {
  const r = recording.get();
  const sel = selected.get();
  if (!r || sel === null || !r.events[sel]) {
    detailEl.innerHTML = '<div class="dim">Select an event to see its effect</div>';
    return;
  }
  detailEl.innerHTML = renderDetail(r, sel);
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
eventsView.addEventListener("click", (e) => {
  const row = e.target.closest(".event");
  const idx = row?.dataset.index;
  if (idx === void 0) return;
  selected.set(Number(idx));
});
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
