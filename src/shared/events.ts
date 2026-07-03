/**
 * Shared event vocabulary for the goblin network — imported by both the
 * visualizer frontend (browser bundle) and, later, the recorder (node).
 *
 * This is the single place that knows, per event kind, *how it changes state*.
 * The visualizer reconstructs subsystem state by folding a recording's events
 * over its baseline snapshot (`replayTo`), and explains any one event by diffing
 * the affected state slice before/after it (see `applyEvent` + `diffEntries`).
 *
 * Design: loose at the edges, strict in the middle. Recording lines stay
 * permissive (`details?: Record<string, unknown>`); each registry entry narrows
 * its own payload via `def<Details>`. Unknown or not-yet-modelled kinds simply
 * have no `reduce` and are treated as no-ops — nothing crashes, they just don't
 * move state. New event kinds are described in exactly one place: here.
 *
 * State mirrors what each goblin persists to disk (and what the recorder
 * snapshots as the baseline), so a `reduce` only tracks *persisted* changes.
 * Transient events (a port closing, a peer connecting/detaching) keep the
 * persisted record and so have a `slice` to show but no `reduce`.
 */

// ---------------------------------------------------------------------------
// Wire shapes (mirror the recording file; kept permissive)
// ---------------------------------------------------------------------------

/** One event line of a recording (`event_log.jsonl`, stamped with goblin id). */
export interface RecordingEvent {
  type: "event";
  goblinId: string;
  ts: string;
  seq: number;
  category: string;
  action: string;
  target?: string;
  details?: Record<string, unknown>;
}

/** Line 0 of a recording: the baseline snapshot of every live goblin. */
export interface RecordingHeader {
  type: "header";
  startedAt: string;
  root: string;
  goblins: { id: string; state: GoblinState }[];
}

/** The `/recording` endpoint payload. */
export interface Recording {
  file: string;
  header: RecordingHeader | null;
  events: RecordingEvent[];
}

// ---------------------------------------------------------------------------
// State model (mirrors the recorder's GoblinSnapshot)
// ---------------------------------------------------------------------------

/** Full replayable state of one goblin. (Purpose isn't a field of its own — it's
 *  just the `Purpose` note, so it lives in `notes`.) */
export interface GoblinState {
  notes: Record<string, string>;
  db: Record<string, string>;
  funcs: Record<string, { code: string; sharedLibs: string[] }>;
  libs: Record<string, string>;
  interfaces: Record<string, string[]>;
  peers: Record<string, string | null>;
  ports: Record<string, { host: string; port: number }>;
}

/** The record-valued slices of {@link GoblinState} a detail view can render. */
export type SliceKey = "notes" | "db" | "funcs" | "libs" | "interfaces" | "peers" | "ports";

/** State of the whole network, keyed by goblin id (`""` = root). */
export type NetworkState = Record<string, GoblinState>;

export function emptyGoblinState(): GoblinState {
  return { notes: {}, db: {}, funcs: {}, libs: {}, interfaces: {}, peers: {}, ports: {} };
}

// ---------------------------------------------------------------------------
// Event registry: label + affected slice + (optional) reducer, per kind
// ---------------------------------------------------------------------------

type Reducer = (state: GoblinState, e: RecordingEvent) => GoblinState;

export interface EventDef {
  /** Human phrasing of the action, e.g. "created lib". */
  label: string;
  /** Which state slice this event reads/writes, and the detail view shows. */
  slice?: SliceKey;
  /** How it mutates state. Omitted for transient / topology-only kinds. */
  reduce?: Reducer;
}

/**
 * Typed registry-entry builder. Inside `reduce`, `e.target`/`e.details` are
 * typed to this kind's payload `D`; the registry stores the type-erased form.
 */
function def<D = Record<string, never>>(
  label: string,
  slice?: SliceKey,
  reduce?: (state: GoblinState, e: { target: string; details: D }) => GoblinState,
): EventDef {
  return { label, slice, reduce: reduce as unknown as Reducer | undefined };
}

// Immutable helpers for a keyed record.
function withKey<V>(rec: Record<string, V>, k: string, v: V): Record<string, V> {
  return { ...rec, [k]: v };
}
function withoutKey<V>(rec: Record<string, V>, k: string): Record<string, V> {
  const out = { ...rec };
  delete out[k];
  return out;
}

/** Every event kind, keyed by `"<category>/<action>"`. */
export const REGISTRY: Record<string, EventDef> = {
  // goblin lifecycle. Purpose is the `Purpose` note, so it writes the notes slice
  // (it's the only purpose signal on a restart where no `notes/set` fires).
  "goblin/started": def("started"),
  "goblin/purpose": def<{ purpose: string }>("purpose set", "notes", (s, e) => ({
    ...s,
    notes: withKey(s.notes, "Purpose", e.details.purpose),
  })),

  // key/value database
  "database/set": def<{ value: string }>("set", "db", (s, e) => ({
    ...s,
    db: withKey(s.db, e.target, e.details.value),
  })),
  "database/deleted": def("deleted", "db", (s, e) => ({ ...s, db: withoutKey(s.db, e.target) })),
  // access (transient): reading a key doesn't change state, but highlights it.
  "database/read": def("read", "db"),

  // notes
  "notes/set": def<{ content: string }>("set", "notes", (s, e) => ({
    ...s,
    notes: withKey(s.notes, e.target, e.details.content),
  })),
  "notes/deleted": def("deleted", "notes", (s, e) => ({ ...s, notes: withoutKey(s.notes, e.target) })),
  // access (transient): reading a note doesn't change state, but highlights it.
  "notes/read": def("read", "notes"),

  // functions (code + which libs they share)
  "func/created": def<{ code: string }>("created func", "funcs", (s, e) => ({
    ...s,
    funcs: withKey(s.funcs, e.target, { code: e.details.code, sharedLibs: s.funcs[e.target]?.sharedLibs ?? [] }),
  })),
  "func/modified": def<{ code: string }>("modified func", "funcs", (s, e) => ({
    ...s,
    funcs: withKey(s.funcs, e.target, { code: e.details.code, sharedLibs: s.funcs[e.target]?.sharedLibs ?? [] }),
  })),
  "func/removed": def("removed func", "funcs", (s, e) => ({ ...s, funcs: withoutKey(s.funcs, e.target) })),
  // invocation (transient): running a func doesn't change state, but highlights it.
  "func/called": def("called func", "funcs"),

  // shared libs
  "func/created lib": def<{ code: string }>("created lib", "libs", (s, e) => ({
    ...s,
    libs: withKey(s.libs, e.target, e.details.code),
  })),
  "func/modified lib": def<{ code: string }>("modified lib", "libs", (s, e) => ({
    ...s,
    libs: withKey(s.libs, e.target, e.details.code),
  })),
  "func/removed lib": def("removed lib", "libs", (s, e) => ({ ...s, libs: withoutKey(s.libs, e.target) })),

  // interfaces (named sets of exposed funcs)
  "func/created interface": def<{ funcs: string[] }>("created interface", "interfaces", (s, e) => ({
    ...s,
    interfaces: withKey(s.interfaces, e.target, e.details.funcs),
  })),
  "func/modified interface": def<{ funcs: string[] }>("modified interface", "interfaces", (s, e) => ({
    ...s,
    interfaces: withKey(s.interfaces, e.target, e.details.funcs),
  })),
  "func/removed interface": def("removed interface", "interfaces", (s, e) => ({
    ...s,
    interfaces: withoutKey(s.interfaces, e.target),
  })),

  // ports. `closed` keeps the persisted record (transient) — slice, no reduce.
  "port/opened": def<{ host: string; port: number }>("opened", "ports", (s, e) => ({
    ...s,
    ports: withKey(s.ports, e.target, { host: e.details.host, port: e.details.port }),
  })),
  "port/closed": def("closed", "ports"),
  "port/removed": def("removed", "ports", (s, e) => ({ ...s, ports: withoutKey(s.ports, e.target) })),

  // peers. `connected`/`detached` keep the persisted binding (transient).
  "peer/attached": def("attached", "peers", (s, e) => ({ ...s, peers: withKey(s.peers, e.target, null) })),
  "peer/connected": def("connected", "peers"),
  "peer/detached": def("detached", "peers"),
  "peer/removed": def("removed", "peers", (s, e) => ({ ...s, peers: withoutKey(s.peers, e.target) })),
  "peer/set interface": def<{ interface: string }>("set interface", "peers", (s, e) => ({
    ...s,
    peers: withKey(s.peers, e.target, e.details.interface),
  })),
  "peer/cleared interface": def("cleared interface", "peers", (s, e) => ({
    ...s,
    peers: withKey(s.peers, e.target, null),
  })),
  // cross-goblin calls (all transient; target = the peer). Outbound: we call a
  // peer (`call`) and its answer arrives (`response`). Inbound: a peer calls us
  // (`request`) and we answer (`served`). `func`/`ok` ride in details.
  "peer/call": def("called peer", "peers"),
  "peer/response": def("peer responded", "peers"),
  "peer/request": def("peer called us", "peers"),
  "peer/served": def("responded to peer", "peers"),

  // agent: a query to this goblin's AI brain (`query`) and the brain's final
  // reply (`response`). No slice — goblin-level activity, not a subsystem entry;
  // the query/response text rides in details.
  "agent/query": def("query"),
  "agent/response": def("response"),

  // spawning child goblins — topology, not a slice of this goblin's state.
  "spawn/spawned": def("spawned"),
  "spawn/removed": def("removed"),
  "spawn/exited": def("exited"),
};

/** The registry entry for an event, if it's a known kind. */
export function lookup(e: { category: string; action: string }): EventDef | undefined {
  return REGISTRY[`${e.category}/${e.action}`];
}

/** Per-category accent colour, shared so every view colours a subsystem alike. */
export const CATEGORY_COLORS: Record<string, string> = {
  goblin: "#c586c0",
  database: "#4ec9b0",
  notes: "#dcdcaa",
  func: "#569cd6",
  port: "#ce9178",
  peer: "#4fc1ff",
  spawn: "#b5cea8",
  agent: "#e06c75",
};

// ---------------------------------------------------------------------------
// Replay: fold events over the baseline to reconstruct state
// ---------------------------------------------------------------------------

/** Network state at recording start, from the header snapshot. */
export function baselineState(header: RecordingHeader | null): NetworkState {
  const out: NetworkState = {};
  for (const g of header?.goblins ?? []) out[g.id] = g.state;
  return out;
}

/** Apply one event to the network, routing it to its goblin's state slice.
 *  Unknown / no-op kinds pass state through unchanged. */
export function applyEvent(state: NetworkState, e: RecordingEvent): NetworkState {
  const d = REGISTRY[`${e.category}/${e.action}`];
  if (!d?.reduce) return state;
  const g = state[e.goblinId] ?? emptyGoblinState();
  return { ...state, [e.goblinId]: d.reduce(g, e) };
}

/** Network state after replaying events `0..index` (inclusive) over the
 *  baseline. `index < 0` returns the baseline itself. */
export function replayTo(
  header: RecordingHeader | null,
  events: RecordingEvent[],
  index: number,
): NetworkState {
  let state = baselineState(header);
  const end = Math.min(index, events.length - 1);
  for (let i = 0; i <= end; i++) state = applyEvent(state, events[i]);
  return state;
}

// ---------------------------------------------------------------------------
// Network topology (the graph): who exists, and their parent, at a point in time
// ---------------------------------------------------------------------------

/** A goblin node in the network graph at some point in the replay. */
export interface GoblinNode {
  /** Path-relative id: `""` = root, `children/foo`, `children/foo/children/bar`. */
  id: string;
  /** Display name — the last path segment, or "root". */
  name: string;
  /** Parent goblin's id, or null for the root. */
  parentId: string | null;
  /** `exited` once its process has exited (kept in the graph, dimmed). */
  status: "alive" | "exited";
}

/** The id of a child spawned as `name` by the goblin `parentId`. */
export function childId(parentId: string, name: string): string {
  return parentId === "" ? `children/${name}` : `${parentId}/children/${name}`;
}

/** The parent id for a goblin id (`""`→null, `children/foo`→`""`). */
export function parentOf(id: string): string | null {
  if (id === "") return null;
  const i = id.lastIndexOf("/children/");
  return i === -1 ? "" : id.slice(0, i);
}

/**
 * Reconstruct the set of live goblins at event `index` by folding spawn events
 * over the baseline: `spawned` adds a child, `exited` dims it, `removed` drops it.
 */
export function topologyAt(
  header: RecordingHeader | null,
  events: RecordingEvent[],
  index: number,
): GoblinNode[] {
  const nodes = new Map<string, GoblinNode>();
  const add = (id: string): void => {
    nodes.set(id, { id, name: id === "" ? "root" : id.split("/").pop()!, parentId: parentOf(id), status: "alive" });
  };

  for (const g of header?.goblins ?? []) add(g.id);

  const end = Math.min(index, events.length - 1);
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

// ---------------------------------------------------------------------------
// Slices + diffing (the "influence" of an event)
// ---------------------------------------------------------------------------

function mapValues<V>(rec: Record<string, V>, f: (v: V) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = f(v);
  return out;
}

/** A state slice flattened to key→display-string, so one diff/render path
 *  handles every subsystem (funcs show code, ports `host:port`, etc.). */
export function sliceEntries(g: GoblinState, slice: SliceKey): Record<string, string> {
  switch (slice) {
    case "notes": return g.notes;
    case "db": return g.db;
    case "libs": return g.libs;
    case "funcs": return mapValues(g.funcs, (f) => f.code);
    case "interfaces": return mapValues(g.interfaces, (fs) => fs.join(", "));
    case "peers": return mapValues(g.peers, (p) => p ?? "(no interface)");
    case "ports": return mapValues(g.ports, (p) => `${p.host}:${p.port}`);
  }
}

export interface EntryDiff {
  key: string;
  before?: string;
  after?: string;
  status: "added" | "removed" | "changed" | "same";
}

/** Compare two key→value slices, one row per key (union), sorted by key. */
export function diffEntries(
  before: Record<string, string>,
  after: Record<string, string>,
): EntryDiff[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.map((key) => {
    const b = before[key];
    const a = after[key];
    const status: EntryDiff["status"] =
      b === undefined ? "added" : a === undefined ? "removed" : b !== a ? "changed" : "same";
    return { key, before: b, after: a, status };
  });
}
