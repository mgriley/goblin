// Generates a sample recording where one goblin ("forge") accumulates many
// entries in every subsystem, several of them long (multi-line func/lib code,
// long notes, long db values). Handy for exercising the anatomy view's layout,
// tile truncation, and hover titles.
//
//   node scripts/gen-rich-recording.mjs > goblin-root/recordings/big-goblin.jsonl
//
// Event actions mirror the reducers in src/shared/events.ts.

const START = Date.parse("2026-07-03T12:00:00.000Z");
let clock = 0;
const seqOf = {}; // per-goblin monotonic seq, seeded like the recorder does

const lines = [];
function ts() { return new Date(START + clock++ * 1000).toISOString(); }
function ev(goblinId, category, action, target, details) {
  const seq = (seqOf[goblinId] = (seqOf[goblinId] ?? 0) + 1);
  const e = { type: "event", goblinId, ts: ts(), seq, category, action, target };
  if (details !== undefined) e.details = details;
  lines.push(JSON.stringify(e));
}

// --- header: root baseline -------------------------------------------------
const header = {
  type: "header",
  startedAt: new Date(START).toISOString(),
  root: "goblin-root",
  goblins: [
    { id: "", state: { notes: { Purpose: "orchestrator root" }, db: { env: "prod" }, funcs: {}, libs: {}, interfaces: {}, peers: {}, ports: {} } },
  ],
};
lines.push(JSON.stringify(header));

const FORGE = "children/forge";

// --- some long content -----------------------------------------------------
const longNote = `# Deployment Runbook

1. Drain traffic from the node via the load balancer.
2. Snapshot the on-disk state (notes/, database/, functions/).
3. Roll the new build; watch the health endpoint for 200s.
4. Re-attach peers and confirm interface handshakes.
5. Restore traffic gradually (10% -> 50% -> 100%).

Rollback: keep the previous snapshot for 24h. If error rate
exceeds 2% for 5 consecutive minutes, revert to the snapshot
and re-open the incident channel.`;

const longPurpose = `Build-and-ship coordinator. Owns the compile pipeline, fans work
out to worker peers, aggregates results, and exposes a public
interface for status queries. Keeps a rolling cache of recent
build artifacts in its key/value store.`;

const fetchWithRetryFn = `export async function fetchWithRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
      const backoff = Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}`;

const buildPipelineFn = `export async function runPipeline(spec) {
  const stages = [resolveDeps, compile, bundle, test, sign];
  const ctx = { spec, artifacts: [], warnings: [] };
  for (const stage of stages) {
    const t0 = Date.now();
    await stage(ctx);
    ctx.warnings.push(stage.name + " took " + (Date.now() - t0) + "ms");
  }
  return { ok: ctx.warnings.length < 20, ctx };
}`;

const schedulerFn = `export function schedule(jobs, workers) {
  const queue = [...jobs].sort((a, b) => b.priority - a.priority);
  const assignments = new Map(workers.map((w) => [w, []]));
  let i = 0;
  for (const job of queue) {
    const w = workers[i++ % workers.length];
    assignments.get(w).push(job);
  }
  return assignments;
}`;

const httpLib = `// Small HTTP helper shared across funcs.
export function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
}
export function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}`;

const validateLib = `// Tiny schema validator used by several interfaces.
export function validate(value, schema) {
  const errors = [];
  for (const [key, rule] of Object.entries(schema)) {
    const v = value[key];
    if (rule.required && v === undefined) errors.push(key + " is required");
    if (v !== undefined && rule.type && typeof v !== rule.type)
      errors.push(key + " must be " + rule.type);
  }
  return { valid: errors.length === 0, errors };
}`;

// --- root spawns forge -----------------------------------------------------
ev("", "spawn", "spawned", "forge", { purpose: "build coordinator" });

// --- notes (some long) -----------------------------------------------------
ev(FORGE, "goblin", "purpose", undefined, { purpose: longPurpose });
ev(FORGE, "notes", "set", "Runbook", { content: longNote });
ev(FORGE, "notes", "set", "TODO", { content: "wire up the sign stage; add flaky-test retry" });
ev(FORGE, "notes", "set", "Owners", { content: "primary: forge; backup: root" });
ev(FORGE, "notes", "set", "SLA", { content: "p99 build < 90s, availability 99.9%" });
ev(FORGE, "notes", "set", "Contacts", { content: "oncall@example.com, #forge-incidents" });
ev(FORGE, "notes", "set", "Changelog", { content: "v3: parallel bundling; v2: cache; v1: initial" });

// --- db (some long values) -------------------------------------------------
ev(FORGE, "database", "set", "region", { value: "us-west-2" });
ev(FORGE, "database", "set", "maxWorkers", { value: "12" });
ev(FORGE, "database", "set", "cacheTtl", { value: "3600" });
ev(FORGE, "database", "set", "buildCount", { value: "48213" });
ev(FORGE, "database", "set", "lastArtifact", { value: "sha256:9f2c1a7be0d43f8a12c9e77b5540aa31de88c0e4b6f2197a4c3d5e6f70819abc" });
ev(FORGE, "database", "set", "featureFlags", { value: JSON.stringify({ parallelBundle: true, signArtifacts: true, retryFlaky: false, verboseLogs: false, canary: true }) });
ev(FORGE, "database", "set", "lastError", { value: "none" });
ev(FORGE, "database", "set", "queueDepth", { value: "3" });
ev(FORGE, "database", "set", "uptimeSec", { value: "182734" });

// --- funcs (several, some long) --------------------------------------------
ev(FORGE, "func", "created", "fetchWithRetry", { code: fetchWithRetryFn });
ev(FORGE, "func", "created", "runPipeline", { code: buildPipelineFn });
ev(FORGE, "func", "created", "schedule", { code: schedulerFn });
ev(FORGE, "func", "created", "healthCheck", { code: "export const healthCheck = () => ({ ok: true, ts: Date.now() });" });
ev(FORGE, "func", "created", "clearCache", { code: "export function clearCache(store) { for (const k of store.keys()) store.delete(k); }" });
ev(FORGE, "func", "created", "artifactName", { code: "export const artifactName = (spec) => spec.name + '-' + spec.version + '.tar.gz';" });
ev(FORGE, "func", "created", "summarize", { code: "export const summarize = (ctx) => ctx.artifacts.length + ' artifacts, ' + ctx.warnings.length + ' warnings';" });

// --- libs (some long) ------------------------------------------------------
ev(FORGE, "func", "created lib", "http", { code: httpLib });
ev(FORGE, "func", "created lib", "validate", { code: validateLib });
ev(FORGE, "func", "created lib", "clock", { code: "export const now = () => Date.now();\nexport const iso = () => new Date().toISOString();" });
ev(FORGE, "func", "created lib", "ids", { code: "export const uid = () => Math.random().toString(36).slice(2, 10);" });

// --- interfaces ------------------------------------------------------------
ev(FORGE, "func", "created interface", "public", { funcs: ["healthCheck", "summarize"] });
ev(FORGE, "func", "created interface", "build", { funcs: ["runPipeline", "artifactName", "schedule"] });
ev(FORGE, "func", "created interface", "admin", { funcs: ["clearCache", "runPipeline", "healthCheck"] });
ev(FORGE, "func", "created interface", "net", { funcs: ["fetchWithRetry"] });

// --- ports -----------------------------------------------------------------
ev(FORGE, "port", "opened", "http", { host: "0.0.0.0", port: 8080 });
ev(FORGE, "port", "opened", "metrics", { host: "127.0.0.1", port: 9100 });
ev(FORGE, "port", "opened", "grpc", { host: "0.0.0.0", port: 50051 });
ev(FORGE, "port", "opened", "admin", { host: "127.0.0.1", port: 7000 });
ev(FORGE, "port", "opened", "debug", { host: "127.0.0.1", port: 6006 });

// --- peers (attach + set interface) ----------------------------------------
for (const [name, iface] of [["worker-a", "build"], ["worker-b", "build"], ["worker-c", "build"], ["cache", "public"], ["registry", "net"]]) {
  ev(FORGE, "peer", "attached", name);
  ev(FORGE, "peer", "set interface", name, { interface: iface });
}

// --- a burst of access/activity events (all transient — they highlight an entry
//     but don't change persisted state) ------------------------------------
ev(FORGE, "agent", "query", undefined, { query: "What's the build status for release 3.2, and are all workers healthy?" });
ev(FORGE, "notes", "read", "Runbook");
ev(FORGE, "database", "read", "featureFlags");
ev(FORGE, "func", "called", "runPipeline");
ev(FORGE, "peer", "call", "worker-a", { func: "runPipeline" });       // we call a peer
ev(FORGE, "peer", "response", "worker-a", { func: "runPipeline", ok: true });
ev(FORGE, "peer", "request", "cache", { func: "healthCheck" });       // a peer calls us
ev(FORGE, "peer", "served", "cache", { func: "healthCheck", ok: true });
ev(FORGE, "agent", "response", undefined, { response: "Release 3.2 built OK (48213 total builds). worker-a/b/c healthy; cache responding. No blockers." });

process.stdout.write(lines.join("\n") + "\n");
