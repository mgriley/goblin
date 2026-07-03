// src/shared/events.ts
function emptyGoblinState() {
  return { notes: {}, db: {}, funcs: {}, libs: {}, interfaces: {}, peers: {}, ports: {} };
}
function def(label, slice2, reduce) {
  return { label, slice: slice2, reduce };
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
function replayTo(header, events, index2) {
  let state = baselineState(header);
  const end = Math.min(index2, events.length - 1);
  for (let i = 0; i <= end; i++) state = applyEvent(state, events[i]);
  return state;
}
function childId(parentId, name) {
  return parentId === "" ? `children/${name}` : `${parentId}/children/${name}`;
}
function parentOf(id) {
  if (id === "") return null;
  const i = id.lastIndexOf("/children/");
  return i === -1 ? "" : id.slice(0, i);
}
function topologyAt(header, events, index2) {
  const nodes = /* @__PURE__ */ new Map();
  const add = (id) => {
    nodes.set(id, { id, name: id === "" ? "root" : id.split("/").pop(), parentId: parentOf(id), status: "alive" });
  };
  for (const g of header?.goblins ?? []) add(g.id);
  const end = Math.min(index2, events.length - 1);
  for (let i = 0; i <= end; i++) {
    const e = events[i];
    if (e.category !== "spawn" || !e.target) continue;
    const id = childId(e.goblinId, e.target);
    if (e.action === "spawned") add(id);
    else if (e.action === "removed") nodes.delete(id);
    else if (e.action === "exited") {
      const n = nodes.get(id);
      if (n) n.status = "exited";
    }
  }
  return [...nodes.values()];
}
function mapValues(rec, f) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) out[k] = f(v);
  return out;
}
function sliceEntries(g, slice2) {
  switch (slice2) {
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
var index = signal(0);
var playing = signal(false);
var speed = signal(1);
var selected = signal("");
var slice = signal("notes");
var status = signal(null);
var SLICES = ["notes", "db", "funcs", "libs", "interfaces", "peers", "ports"];
var SLICE_COLORS = {
  notes: CATEGORY_COLORS.notes,
  db: CATEGORY_COLORS.database,
  funcs: CATEGORY_COLORS.func,
  libs: "#4a7ab0",
  interfaces: "#7fb0e0",
  peers: CATEGORY_COLORS.peer,
  ports: CATEGORY_COLORS.port
};
var graphEl = document.getElementById("graph");
var eventLog = document.getElementById("event-log");
var eventCard = document.getElementById("event-card");
var goblinPanel = document.getElementById("goblin-panel");
var fileEl = document.getElementById("file");
var metaEl = document.getElementById("meta");
var posEl = document.getElementById("position");
var statusEl = document.getElementById("status");
var playBtn = document.getElementById("play");
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function trunc(s, n = 120) {
  if (s == null) return "";
  return s.length > n ? s.slice(0, n) + "\u2026" : s;
}
function fmtTime(ts) {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? esc(ts) : d.toISOString().slice(11, 19);
}
var catColor = (cat) => CATEGORY_COLORS[cat] ?? "#888";
function curEvent(r) {
  return r.events.length ? r.events[Math.min(index.get(), r.events.length - 1)] : null;
}
function shortGoblin(id) {
  return id === "" ? "root" : id.split("/").pop();
}
function goblinDepth(id) {
  return id === "" ? 0 : (id.match(/children\//g) ?? []).length;
}
function renderGoblinCard(n, r, net) {
  const state = net[n.id] ?? emptyGoblinState();
  const e = curEvent(r);
  const touchSlice = e && e.goblinId === n.id ? lookup(e)?.slice ?? null : null;
  const touchKey = touchSlice ? e.target ?? null : null;
  const regions = SLICES.map((sk) => {
    const entries = sliceEntries(state, sk);
    const keys = Object.keys(entries).sort();
    const tiles = keys.map((k) => {
      const touched = sk === touchSlice && k === touchKey;
      return `<div class="tile${touched ? " touched" : ""}" data-slice="${sk}" title="${esc(trunc(entries[k], 240))}">${esc(k)}</div>`;
    }).join("");
    return `<div class="region${keys.length ? "" : " empty"}${sk === touchSlice ? " active" : ""}" style="--c:${SLICE_COLORS[sk]}" data-slice="${sk}">
        <div class="region-head"><span class="dot"></span>${sk}<span class="rn">${keys.length}</span></div>
        ${keys.length ? `<div class="tiles">${tiles}</div>` : ""}
      </div>`;
  }).join("");
  const affected = e?.goblinId === n.id;
  const cls = ["gcard", n.status === "exited" ? "exited" : "", n.id === selected.get() ? "selected" : "", affected ? "affected" : ""].filter(Boolean).join(" ");
  const styles = [`margin-left:${goblinDepth(n.id) * 18}px`];
  if (affected && e) styles.push(`--ec:${catColor(e.category)}`);
  return `<div class="${cls}" data-goblin="${esc(n.id)}" style="${styles.join(";")}">
      <div class="gcard-head">
        <span class="gc-name">${esc(n.name)}</span>
        ${n.parentId !== null ? `<span class="gc-parent">\u25C2 ${esc(shortGoblin(n.parentId))}</span>` : ""}
        ${n.status === "exited" ? `<span class="gc-exited">exited</span>` : ""}
      </div>
      <div class="regions">${regions}</div>
    </div>`;
}
function renderAnatomy(r) {
  const nodes = topologyAt(r.header, r.events, index.get()).sort((a, b) => a.id.localeCompare(b.id));
  if (!nodes.length) {
    graphEl.innerHTML = '<div class="dim">No goblins</div>';
    return;
  }
  const net = replayTo(r.header, r.events, index.get());
  graphEl.innerHTML = `<div class="anatomy">${nodes.map((n) => renderGoblinCard(n, r, net)).join("")}</div>`;
}
function renderPanelEntry(d, touched) {
  let v;
  if (d.status === "changed") {
    v = `<span class="was">${esc(trunc(d.before))}</span><span class="arrow">\u2192</span><span class="now">${esc(trunc(d.after))}</span>`;
  } else if (d.status === "removed") {
    v = `<span class="was">${esc(trunc(d.before))}</span>`;
  } else {
    v = `<span class="now">${esc(trunc(d.after ?? d.before))}</span>`;
  }
  const cls = `entry ${d.status === "same" ? "" : d.status}${touched ? " touched" : ""}`.trim();
  return `<div class="${cls}"><span class="k">${esc(d.key)}</span><span class="v">${v}</span></div>`;
}
function renderEventCard(r) {
  const e = curEvent(r);
  if (!e) {
    eventCard.innerHTML = '<div class="dim">No events</div>';
    return;
  }
  const def2 = lookup(e);
  const label = def2?.label ?? `${e.category} ${e.action}`;
  const head = `<div class="ec-head">
      <span class="ec-cat" style="color:${catColor(e.category)}">${esc(e.category)}\xB7<b>${esc(e.action)}</b></span>
      ${e.target ? `<span class="ec-target">${esc(e.target)}</span>` : ""}
      <span class="ec-seq">#${esc(e.seq)} \xB7 ${fmtTime(e.ts)}</span>
    </div>`;
  let body = "";
  if (def2?.slice) {
    const i = index.get();
    const before = sliceEntries(replayTo(r.header, r.events, i - 1)[e.goblinId] ?? emptyGoblinState(), def2.slice);
    const after = sliceEntries(replayTo(r.header, r.events, i)[e.goblinId] ?? emptyGoblinState(), def2.slice);
    const touched = diffEntries(before, after).find((d) => d.key === e.target);
    body = touched ? renderPanelEntry(touched, true) : `<div class="dim">no persisted change (${esc(def2.slice)})</div>`;
  } else if (e.details) {
    body = `<pre class="dim" style="white-space:pre-wrap">${esc(JSON.stringify(e.details, null, 2))}</pre>`;
  }
  eventCard.innerHTML = head + body;
}
function renderGoblinPanel(r) {
  const gid = selected.get();
  const i = index.get();
  const sk = slice.get();
  const after = replayTo(r.header, r.events, i);
  const before = replayTo(r.header, r.events, i - 1);
  const gAfter = after[gid] ?? emptyGoblinState();
  const gBefore = before[gid] ?? emptyGoblinState();
  const tabs = SLICES.map((s) => {
    const n = Object.keys(sliceEntries(gAfter, s)).length;
    return `<span class="tab${s === sk ? " active" : ""}" data-slice="${s}">${s}<span class="n">${n}</span></span>`;
  }).join("");
  const e = curEvent(r);
  const touchKey = e && e.goblinId === gid && lookup(e)?.slice === sk ? e.target : null;
  const diffs = diffEntries(sliceEntries(gBefore, sk), sliceEntries(gAfter, sk));
  const rows = diffs.length ? diffs.map((d) => renderPanelEntry(d, d.key === touchKey)).join("") : `<div class="dim">(${esc(sk)} empty)</div>`;
  goblinPanel.innerHTML = `<div class="gp-head">${esc(gid || "root")}</div>
    <div id="tabs">${tabs}</div>${rows}`;
}
function buildLog(r) {
  eventLog.innerHTML = r.events.length ? r.events.map((e, i) => `<div class="log-row" data-index="${i}">
        <span class="l-seq">${i + 1}</span>
        <span class="l-gob" title="${esc(e.goblinId || "root")}">${esc(shortGoblin(e.goblinId))}</span>
        <span class="l-act" style="color:${catColor(e.category)}">${esc(e.category)}\xB7${esc(e.action)}</span>
        <span class="l-tgt">${e.target ? esc(e.target) : ""}</span>
      </div>`).join("") : '<div class="dim">No events</div>';
}
function highlightLog(r) {
  if (!r.events.length) return;
  const cur = Math.min(index.get(), r.events.length - 1);
  eventLog.querySelector(".log-row.active")?.classList.remove("active");
  const row = eventLog.querySelector(`.log-row[data-index="${cur}"]`);
  if (row) {
    row.classList.add("active");
    row.scrollIntoView({ block: "nearest" });
  }
}
effect(() => {
  const r = recording.get();
  if (!r) {
    graphEl.innerHTML = '<div class="dim">Loading\u2026</div>';
    return;
  }
  renderAnatomy(r);
});
effect(() => {
  const r = recording.get();
  if (r) renderEventCard(r);
});
effect(() => {
  const r = recording.get();
  if (r) renderGoblinPanel(r);
});
effect(() => {
  const r = recording.get();
  if (r) buildLog(r);
});
effect(() => {
  const r = recording.get();
  if (r) highlightLog(r);
});
effect(() => {
  const r = recording.get();
  if (!r) return;
  fileEl.textContent = r.file ?? "";
  const parts = [];
  if (r.header?.root) parts.push(r.header.root);
  parts.push(`${r.events.length} events`);
  metaEl.textContent = parts.join(" \xB7 ");
});
effect(() => {
  const r = recording.get();
  const n = r?.events.length ?? 0;
  const i = Math.min(index.get(), Math.max(0, n - 1));
  const e = r && n ? r.events[i] : null;
  posEl.textContent = n ? `#${i + 1} / ${n}${e ? "  " + fmtTime(e.ts) : ""}` : "\u2014";
  playBtn.textContent = playing.get() ? "\u275A\u275A" : "\u25B6";
});
effect(() => {
  const s = status.get();
  statusEl.textContent = s?.text ?? "";
  statusEl.className = s?.ok ? "live" : s ? "error" : "";
});
var playTimer = null;
effect(() => {
  const p = playing.get();
  const sp = speed.get();
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
  if (!p) return;
  playTimer = setInterval(() => {
    const r = recording.get();
    if (!r) return;
    const n = r.events.length;
    const cur = index.get();
    if (cur >= n - 1) {
      playing.set(false);
      return;
    }
    index.set(cur + 1);
  }, 600 / sp);
});
graphEl.addEventListener("click", (e) => {
  const t = e.target;
  const card = t.closest("[data-goblin]");
  if (card?.dataset.goblin === void 0) return;
  selected.set(card.dataset.goblin);
  const region = t.closest("[data-slice]");
  if (region?.dataset.slice) slice.set(region.dataset.slice);
});
goblinPanel.addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (t?.dataset.slice) slice.set(t.dataset.slice);
});
eventLog.addEventListener("click", (e) => {
  const row = e.target.closest(".log-row");
  if (row?.dataset.index !== void 0) {
    playing.set(false);
    index.set(Number(row.dataset.index));
  }
});
document.getElementById("play").addEventListener("click", () => {
  const r = recording.get();
  if (!r || !r.events.length) return;
  if (!playing.get() && index.get() >= r.events.length - 1) index.set(0);
  playing.set(!playing.get());
});
document.getElementById("step-back").addEventListener("click", () => {
  playing.set(false);
  index.set(Math.max(0, index.get() - 1));
});
document.getElementById("step-fwd").addEventListener("click", () => {
  const r = recording.get();
  if (r) {
    playing.set(false);
    index.set(Math.min(r.events.length - 1, index.get() + 1));
  }
});
document.getElementById("speed").addEventListener("change", (e) => speed.set(Number(e.target.value)));
var inited = false;
async function fetchRecording() {
  try {
    const res = await fetch("/recording");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    recording.set(data);
    if (!inited && data.events.length) {
      index.set(data.events.length - 1);
      inited = true;
    }
    status.set({ ok: true, text: "\u25CF Live" });
  } catch (e) {
    status.set({ ok: false, text: `\u26A0 ${e.message}` });
  }
}
fetchRecording();
setInterval(fetchRecording, 2e3);
