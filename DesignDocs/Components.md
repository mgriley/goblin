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

### Function Execution

To keep things simple for V1, the node process itself should just execute the function. This will keep things much simpler IMO. 

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

### Persisting peers

In this case, a peer is a sub-process of the elf proc, so it can't be "persisted" in the same way as a file. I think simplest thing
to do is for the PeerManager to track a peer's state (its name, interface, etc), then another component (like SpawnManager) is
responsible for actually bringing up the peers on restart. When the peer connects again, its previous interface+options will apply.

In this way, the idea of a "peer" is pretty loose. A peer added to PeerManager is not necessarily currently connected or active.
Other components like SpawnManager are responsible for the mechanics of bringing up/down the peers, but are not responsible for things like
assigning interfaces, etc.


## SpawnManager
To start, the only peers are the processes in our process hierarchy. We can communicate with our parent proc by IPC and with our
child procs by IPC. The SpawnManager handles the details of spawning sub-proces and calling PeerManager funcs to setup a peer
for each spawned actor.

SpawnActor(name, purpose)
RemoveActor(name)

SpawnAllExisting()
- Spawns actors by reading disk and seeing where we left off. Called only on startup.


## Database
Each peer has access to a KV-store database that it can use to store any data it needs (such as customer account data).
Could also just be a virtual filesystem backed by the actual file-system. The agent would know how to work with this right away.

This should be a pretty simple KV-store interface, like follows:
- SetValue(path, string)
- GetValue(path)
- DeleteValue(path)
- ListKeysWithPrefix(prefix)

Sets should use atomic write (write to tmp then rename).
Reads should return Result type instead of throwing on error

### Persistence

For now, the database should be stored as a flat dir on disk, where each kv entry is a file where the name is the key percent-encoded.
Instead of storing everything in memory (like the other mgrs), reads+writes should just operate on the underlying files.

Later, can swap out to use an actual nice DB if needed.

Implemented in `src/database/database.ts`. Flat `database/<percent-encoded-key>` layout (dots also escaped so a key can't become `.`/`..`/a dotfile),
no in-memory cache, atomic writes (temp file + rename), and `getValue`/`listKeysWithPrefix` return a `Result` instead of throwing.

### Add schemas?
Arguably, each path should also contain the json schema of the value contained in it. Or, have a schema registry and assign each entry
a name in the schema registry. Not sure if this is a good idea or just overcomplicates things.

^ For V1, this will overcomplicate things, so do not do this. The whole point of the agent is that it is meant to be self-healing, so it
should be able to adapt to errors when reading DB values for example.

Later, if want to do the schemas thing, recommended to have a separate thing called "collections" where each entry in a collection strictly
follows the collection schema.


## NotesManager
The AI "brain" needs to be able to record some persistent notes that it can read on startup to understand its purpose, in-progress
tasks, etc. Should have a simple notes interface for this. Each note is just name => string. By default, the agent's system prompt
should tell it to read its "Purpose" note (set on init), its "Memory" note, and its "Tasks" note.

Implemented in `src/notes/notes_manager.ts`. In-memory map is the source of truth, mirrored one-file-per-note to `notes/<name>.md`
(the content is the file, so no manifest is needed); restored by reading the directory on `start()`. `SetNote` is an upsert.

- SetNote(name, string)
- GetNote(name)
- DeleteNote(name)
- ListNotes()


## PortsManager
PortsManager opens listening ports so that an Elf can behave as a server. Currently, the only
supported protocol is HTTP. The PortsManager creates `HttpPeer` objects
that register themselves as peers with the PeerManager. Each `HttpPeer` opens a
listening port that, upon receiving an HTTP message, forwards it to PeerManager (like any other peer).
Thus, having an Elf act like a server is just a matter of spawning an HttpPeer for it. From
there, it reuses all the same mechanisms for functions+interfaces that any peer uses.

The key idea: **an open port is just another kind of peer.** An inbound HTTP request is
translated into the same `invokeFunction(funcName, inData)` call that an IPC request makes, so
it passes through the identical access-control gate (the peer's assigned interface) and lands
in FunctionManager.

For comparison:
  IPC:   forked child  --IpcPeer-->   PeerManager.invokeFunction --> FunctionManager
  HTTP:  HTTP request  --HttpPeer-->  PeerManager.invokeFunction --> FunctionManager

### HttpPeer (the transport)

A concrete `AbstractPeer` over Node's built-in `http.Server` (zero deps). It is
*inbound-only*: there is no single counterparty to push to, so `sendRpc` returns an error
result ("http peer is inbound-only"). Its whole job is the inbound direction:

  HTTP request  ->  (funcName, inData)  ->  managerHandle.invokeFunction  ->  CallResult  ->  HTTP response

Request mapping (V1, deliberately minimal):
  - `POST /<funcName>`, request body is `inData` (JSON text)
  - 200 + output JSON text          on  { ok: true }
  - 4xx/5xx + error string in body  on  { ok: false }  (e.g. 404 unknown/denied, 500 runtime)
  - `GET /`  ->  health check / optional list of callable funcs in the assigned interface

All anonymous clients of a port share a single peer identity — "the public edge for port N".
Access is scoped per-port: open one port bound to interface `publicApi`, another bound to
`adminApi`. The interface assigned to that peer IS the public API surface; nothing outside it
is reachable. To expose more or less, change the peer's interface (PeerManager), not the port.

Implemented in `src/peers/ports_manager.ts` (lifecycle + persistence) and `src/peers/http_peer.ts`
(the transport). PortsManager binds the socket *before* attaching the peer, so a bind failure
(e.g. port in use) throws without leaving a phantom peer; `port: 0` binds an ephemeral port and
the resolved value is what gets persisted. HttpPeer maps `POST /<funcName>` (body = inData) to
`invokeFunction`, `GET /` to a health check, and CallResult errors onto HTTP statuses
(403 no interface / 404 unknown func / 400 bad input / 500 runtime), with a 1 MiB body cap.

### API

OpenPort(name, { port, host? })  - create+listen an http.Server, wrap in HttpPeer, attachPeer(name, ...)
ClosePort(name)                  - stop listening, detachPeer(name) (keeps the binding)
RemovePort(name)                 - close + forget (removePeer + drop from store)
OpenAllExisting()                - on startup, reopen every persisted port
listListening()

### Persistence (mirrors SpawnManager)

PortsManager persists only the *existence* bits it owns — `name -> { port, host }` — to
`ports.json`. The interface binding is already persisted by PeerManager in `peers.json`. On
restart, `OpenAllExisting()` reopens each socket and re-attaches it as a peer; PeerManager
reapplies the remembered interface automatically. Same split as "SpawnManager owns the
workspace dir, PeerManager owns the interface".

### Security note

`host` defaults to loopback (`127.0.0.1`); binding `0.0.0.0` to face the network is an explicit
choice. The assigned interface is the only authz boundary — there is no per-client auth in V1,
so a port's interface should expose exactly what is safe for any caller that can reach it. If an
Elf wishes to implement some form of user auth (like for user accounts), it can implement that
using normal functions, with shared libs and the database.


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
