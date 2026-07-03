# Goblin

Goblin is an experimental server that implements itself at runtime.

Think of it as a REST server with a built-in agent loop and script interpreter. The agent dynamically generates scripts and wires
them up to web endpoints to implement the server of your dreams. Essentially, goblin embeds its own mini development team.
Tell it what you want and it will get cooking!

Use it to:
- Rapidly prototype servers
- Create your own self-hosted webapps
- Strike fear into the hearts of security researchers

Cool features:
- Self-Healing: Errors bubble up to the agent, allowing it fix broken scripts on the fly
- Self-Scaling: Goblins can fork sub-goblins to create a goblin empire
- Database & Memory: Built-in KV store for user data and agent "notes" system
- Inspect & Visualize: Inspect and visualize your goblin as it implements itself
- Hackable: The code has an (IMO) clean and simple core for easy hacking

## Goblin in action

Making a chat app:
See recording

Making a notes app:
See recording

Include the visualizations of some sample runs here! This is the main hook. Should be good-looking graphics of the goblin running in production!

## Run your own!

Instructions on how to run the docker for yourself. 

## The concept - living systems

Goblin is an example of what I've been calling a "living system" (until I think of something better :P). It is a server/system
that uses an embedded agent to write (and revise) the scripts that contain its business logic. 

Why do this crazy thing?

Consider the typical bug resolution process: some code fails, a bug is reported, a programmer fixes it, then the fix is deployed.
The end-user gets the fix days to weeks later (if they're lucky).

With a living system, the fix is done locally and near-instantly. The interpreted code bubbles up an exception, the embedded agent fixes it, and
the code is updated in-place. The entire resolution might occur so fast that the user's original web request can still be served.

My humble prediction is that within the not-so-distant future there will be major production-grade systems built this way. Embedded or colocated agents will update major components transparently at runtime, for things like intelligent autoscaling, dynamic error-recovery, and reacting to changes in downstream APIs.

## Design

When you run `goblin`, it starts a single root goblin. Each goblin is a `node` process that runs a) an agent loop, and b) a worker thread for interpreting code.

At first, a goblin doesn't contain any business logic at all! Instead, each goblin comes with the essential tool-calls for writing its own scripts.

TODO, more design details here

To interact with goblin, the root goblin serves an admin console at `localhost:7777` where the user can tell the agent what to do. The root goblin is instructed to spawn
subprocesses to prevent handling everything itself. Each subprocress is its own self-contained goblin with its own agent and all subcomponents.
Goblins communicate by exposing RPC interfaces to each other, which they update as they go.

## Security

Goblin runs LLM-generated scripts at runtime using a javascript intrepreter (node). These scripts should be considered untrusted code.
Unlike a web browser, goblin doesn't yet have all the sandboxing in place to prevent well-meaning but dysfunctional (or downright malicious) scripts
from running wild. Runaway scripts might touch files they shouldn't, use up all of your disk, etc. The plan is to add better sandboxing here, similar to a browser, but that's work-in-progress. Currently,
the generated scripts run in node WorkerThreads, which have access to APIs for reading/writing files, sending network requests, etc.

To be safe, please run Goblin in a docker container (see instructions in 'Running') or in an isolated VM. 

Please also make sure that the API token you use is setup with limits and does not have auto-pay enabled.

## Development

Goblin is currently written in typescript and uses the `node` runtime. The concept here can be easily recreated with any combo of system language plus scripting language, though. I'd like to do a Rust+Lua version at some point.

One of the goals was to use as few dependencies as possible, in the hopes of making things easier to port and hack on.
The `node` version currently has no `npm` dependencies (other than a couple dev dependencies).

## Contributing

If you're interested in contributing, please open an issue first! This way we can discuss if your change is a good fit and figure out details before jumping right into the code.
