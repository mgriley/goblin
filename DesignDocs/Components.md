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
