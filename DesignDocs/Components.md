# Actor Components
05/27/2026

Each actor should have these set of components. By using these components alone, each actor should be powerful enough
to accomplish the purpose assigned by its parent (likely some generic web-server tasks, like a slice of app functionality).

Major system components:
- FunctionManager
- PeerManager
- SpawnManager

Here is a loose outline of how each should be implemented. Do not take these function signatures too literally.
Just use them as inspiration for the general design here.

## FunctionManager

A way for each actor to create internal functions, which will be executed by dynamically importing the given javascript text and 
executing the exported "handle" function. Mental model is that actor creates its mini library of self-contained micro-functions
that it exposes to its peers.

### The basic unit is a "function" which is a single function with an input and output schema
CreateFunc(name, code)
RemoveFunc(name)
ModifyFunc(name, newCode)
GetFunc(funcName)
ExecuteFunc(name, inputData: string): string

### Functions are grouped into "interfaces" which are exposed to peers
AddInterface(name, funcsList)
RemoveInterface(name)
ChangeInterface(name, newFuncsList)
GetInterface(name)

### To give the agent some ability to reuse code, we can create files that export a single "lib"
### var, which can be passed into a func.
AddSharedLib(name, code)
RemoveSharedLib(name)
ModifySharedLib(name, newCode)
SetSharedLibs(funcName, sharedLibs)
GetSharedLib(name)

### Other notes:
The FunctionManager should store the code in memory for efficiency, but also backup any changes to disk so that everything can
be restored if the actor restarts. Shouldn't be too hard. Just keep a directory and have one file per function. Function names
must be valid file-names.

Not sure a great way yet to handle the input/output schema. Should probably register the input/output schema as part of the API
here. Then, coerce the result to that format when it is returned. This way, can arbitrarily support different languages, etc
in the future for executing requests.


## PeerManager

PeerManager manages the edges in/out of this node. A node can communicate with its connected peers. Each connected peer is
an assigned an interface (see FunctionManager), and peers can only call functions in their assigned interface.

Each "peer" must derive an abstract/interface "AbstractPeer" class. For now, just has a single function "handleSend(funcName, inData)"
that must be implemented. Also takes a "PeerCallbacks" object in the ctor that should call into for things like when a message is
received from the peer (which hooks into the FunctionManager => ExecuteFunc function).

AddPeer(name, PeerObj)
SetPeerInterface(peerName, interfaceName)
RemovePeer(name)
GetPeers(name)


## SpawnManager
To start, the only peers are the processes in our process hierarchy. We can communicate with our parent proc by IPC and with our
child procs by IPC. The SpawnManager handles the details of spawning sub-proces and calling PeerManager funcs to setup a peer
for each spawned actor.

SpawnActor(name, purpose)
RemoveActor(name)

SpawnAllExisting()
- Spawns actors by reading disk and seeing where we left off. Called only on startup.


## More Notes

### Minimize dependencies

I would prefer to keep this project at 0 external dependencies (or close to that). I want to keep the basic mechanisms very simple.
Also want it to be a self-contained program/concept that can be ported to other languages easily.

### Persistence

An Elf's full state should be able to be restored when it restarts. That means that for each manager the various functions should persist
the changes to disk. On startup, an Elf restores its full state.

### Free-form messenging

In the current design, an elf can only message its direct parent and direct children. This should be fine to start, but I suspect we
may want some kind of slack-like messenging system later on. If a node is stuck, can send a message to a "General" channel, which triggers
all nodes in the channel to respond to the message. Useful if multiple nodes need to agree on a plan for some impl detail.


## Claude's Suggestions
Notes from a design review (05/31/2026). Overall the three-manager decomposition is sound: it maps cleanly
onto "what an elf can do" (FunctionManager), "who it can talk to" (PeerManager), and "how the tree grows"
(SpawnManager). Interfaces-as-capability-sets is a nice simple access model, and AbstractPeer/handleSend is the
right seam for swapping IPC -> network later. Points to tighten up:

### Function execution mechanism (chosen approach)
The key fact: Node's module registry is per-realm with no eviction API. Once you `import()` something you can't
un-import it from that realm; calling `import()` again with the same URL just returns the cache. So:
- Hot-reload (ModifyFunc) requires a fresh URL each time, typically a cache-busting query (`?v=2`). The old
  version stays resident.
- True unload (reclaiming memory) is only possible by destroying the realm. A Worker *is* its own realm, so
  `worker.terminate()` is the only clean "free everything this worker loaded" operation. The realm is the unit
  of unload — which means the thing we wanted anyway (run async in a worker) is also our unload mechanism.

**Plan: one long-lived executor Worker per elf** (start single-worker), holding a `Map<name, handle>`, driven by
RPC messages from the elf's main thread. Functions live as `.mjs` files on disk (which we persist anyway); the
worker `import()`s them with a `?v=<version>` query for hot-reload. This gives:
- Async / off the main thread — the elf's event loop and IPC never block on user code. This is the isolation that
  matters: a bad function degrades function execution, not the elf's ability to talk to its parent.
- Efficient load — import once, keep the `handle` reference warm in the Map; repeated calls are a lookup + await.
- Cheap soft-unload — `Map.delete(name)` makes it non-callable instantly.
- Real unload (reclaim memory) — terminate + respawn the worker, then reload the current function set from disk.
  Do this on a threshold or on demand, not per call.

Protocol between main thread and worker: `{kind:'load', name, path, version}`, `{kind:'unload', name}`,
`{kind:'exec', id, name, input}` -> `{id, ok, output|error}`. Correlate by id, handle timeouts on the main thread.
Built-ins only (`worker_threads`, `node:crypto`, `node:url`) — no new deps. Shared libs fit naturally: a function
file `import`s a sibling `libs/<name>.mjs`; when a lib changes, bump the version on dependent functions.

**Known tradeoff (why start single-worker):** a timeout on a shared worker does NOT cancel the runaway function —
it just stops us waiting; the code keeps running. The only hard-kill is `terminate()`, which kills every in-flight
call on that worker. So:
- Single worker (V1): simplest, great for I/O-bound async funcs that interleave cooperatively. A hung/CPU-pegged
  func stalls other function calls (not the elf), and recovery means recycling and losing all concurrent calls.
- Small worker pool (later): dispatch each call to a free worker; on timeout terminate just that one and respawn,
  losing only one call. The "real" answer once generated code is expected to hang/burn CPU.

Build single-worker now, but structure the executor so `exec` picks "a worker" not "the worker," so growing to a
pool is a local change. Avoid the `vm` module for this — its ESM support is experimental and fiddly; workers are
the clean path. Note `worker.terminate()` is abrupt and won't run cleanup/finally, so functions shouldn't hold
un-flushed external state.

### ExecuteFunc API cleanup
- It's listed twice with conflicting signatures. Settle on one: `async ExecuteFunc(name, inputData: string):
  Promise<string>` (dynamic import + the `handle` are async).
- Bake in a timeout + structured error return here, since a cross-peer call must fail gracefully, not hang.

### Schemas: a hand-rolled JSON Schema subset (no deps)
The "not sure a great way yet" note is settled by a small, dependency-free JSON Schema subset rather than zod.
This keeps the project portable to other languages (each only needs to reimplement a ~70-line validator) and
the schema *is already* the wire format for advertising an interface to a peer — no serialization step.

Subset: `type` of object/array/string/number/integer/boolean/null, plus `properties` / `required` /
`additionalProperties` for objects, `items` for arrays, `const` and `enum` for fixed values, `default` for
defaults, and `oneOf` for unions (covers zod's discriminatedUnion — variants carry a `const` discriminator and
the validator picks the matching branch). A single `validate(schema, value)` does strict checking + default
filling, no surprise type coercion (closest to zod's `.parse`).

Bonus: `tools.ts` already hand-writes JSON Schema in each tool's `parameters` (the LLM API requires that format),
so the zod schemas there are pure duplication — point `validate()` at the existing `parameters` and delete the
zod copy. The only thing lost is `z.infer` (compile-time types); hand-write the few TS types instead. This
supersedes the earlier function-execution note's mention of zod.

### The Router is referenced but undefined
The doc points at a "RouteManager" twice but it isn't in the major-components list, and the code already has a
`Router`/`RouteHandler`. Either fold routing into one of the three managers or list Router as a first-class
component, and define how Router vs FunctionManager divide the func registry (they currently look overlapping).

### Persist more than function code
The "More Notes" section already calls for full state restore — good. The specific gotcha: persist not just
function code but interface definitions, peer->interface assignments, and func->sharedLib associations. Otherwise
SpawnAllExisting brings the process back but it's forgotten who's allowed to call what.

### Smaller cleanups
- Terminology: this doc mixes "actor" and "elf"; the main doc and code say "elf." Align on one.
- Verb consistency: CreateFunc / AddInterface / AddSharedLib / ModifyFunc / ChangeInterface / ModifySharedLib —
  pick one verb per operation across all three managers.
- `GetPeers(name)` reads like a single-peer getter; split into `GetPeer(name)` + `ListPeers()`.
- Supervision: SpawnManager has no crash/restart handling, but the main doc says parents restart children. Even
  "on child exit, mark failed, no auto-restart in V1" is worth stating so the gap is intentional.
- Lifecycle state (spawning/idle/working/failed/terminated from the main doc) is currently homeless — decide
  whether it lives in SpawnManager or its own concern.