# Goblin

Goblin is an experimental server that writes and revises itself at runtime. It embeds an agent to edit its own scripts in-place,
allowing rapid iteration and self-healing.

Goblin is currently written in typescript and uses the `node` runtime. The concept here can be easily recreated in any combo of
system language plus scripting language, though. C++/Rust + Lua would be a good alternative, for example.

## Goblin in action

Goblin creates a notes app (recording):

Goblin creates a chat app (recording): 


Include the visualizations of some sample runs here! This is the main hook. Should be good-looking graphics of the goblin running in production!

## Running

Instructions on how to run the docker for yourself. 


## The concept - living systems

Goblin is an example of what I've been calling a "living system" (until I think of something better :P). It is a server/system
that uses an embedded agent to write (and revise) the scripts that contain its business logic. 
Essentially, a living system embeds its own development team, making it capable of rapid iteration and self-healing.

Consider the typical bug resolution process: some code fails, a bug is reported, a programmer fixes it, then the fix is deployed.
The end-user experiences the fix days to weeks later (if they're lucky).

With a living system, the fix is done locally and near-instantly. The interpreted code bubbles up an exception, the embedded agent fixes it, and
the code is updated in-place. The entire resolution might occur so fast that the user's original web request can still be served.

## Design

When you run `goblin`, it starts a single root goblin. Each goblin is a `node` server that runs an agent loop and a worker thread for interpreting code.

At first, a goblin doesn't contain any business logic at all! Instead, each goblin comes with the essential tool-calls for writing its own scripts.

TODO, more design details here

To interact with goblin, the root goblin serves an admin console at `localhost:7777` where the user can tell the agent what to do. The root goblin is instructed to spawn
subprocesses to segment app functionality and prevent handling everything itself. Each subprocress is its own self-contained goblin with its own agent and all subcomponents.
Goblins communicate by exposing RPC interfaces to each other, which they are update as they go.
