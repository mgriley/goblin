/**
 * Elf — one node in the hierarchy. It owns the set of components from
 * DesignDocs/Components.md and wires them together; everything an elf can do is
 * some composition of these managers:
 *
 *   - FunctionManager — its library of micro-functions, grouped into interfaces
 *   - PeerManager     — the edges in/out, and who may call what
 *   - SpawnManager    — forks child elves and registers them as peers
 *   - PortsManager    — opens HTTP ports, each exposed as just another peer
 *   - Database        — a private KV store for whatever data it needs
 *   - NotesManager    — a persistent scratchpad (purpose / tasks / memory)
 *   - Agent           — the LLM "brain" driving it all
 *
 * Persistence is per-manager: each mirrors its state to the elf's work dir, so
 * `run()` restores the full elf (functions, interfaces, peer bindings, ports,
 * notes) and brings child elves + ports back up where they left off.
 */

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Schema } from "./utils/schema.js";
import {
  schemaAny,
  schemaArr,
  schemaObj,
  schemaResult,
  schemaStr,
  schemaVoid,
} from "./utils/schema_utils.js";

import { Agent } from "./agent/agent.js";
import { runCli } from "./cli.js";
import { ELF_SYSTEM_PROMPT, ROOT_PURPOSE } from "./elf_prompt.js";

import { Database } from "./database/database.js";
import { databaseTools } from "./database/tools.js";
import { FunctionManager } from "./functions/function_manager.js";
import { functionManagerTools } from "./functions/tools.js";
import { NotesManager } from "./notes/notes_manager.js";
import { notesManagerTools } from "./notes/tools.js";
import { PeerManager } from "./peers/peer_manager.js";
import { peerManagerTools } from "./peers/tools.js";
import { PortsManager } from "./ports/ports_manager.js";
import { portsManagerTools } from "./ports/tools.js";
import { IpcPeer, type IpcChannel } from "./spawn/ipc_peer.js";
import { SpawnManager } from "./spawn/spawn_manager.js";
import { spawnManagerTools } from "./spawn/tools.js";

// Path to main.{js,ts} sitting next to this file. The extension follows our
// current runtime: `.js` when running compiled output, `.ts` under tsx.
const HERE = fileURLToPath(import.meta.url);
const ENTRY_SCRIPT = path.join(path.dirname(HERE), `main${path.extname(HERE)}`);

// The peer name an elf gives the IPC edge back to whoever forked it.
const PARENT_PEER = "parent";

export type ElfId = string;

export interface ElfConfig {
  rootDir: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
}

export const ElfConfigSchema = new Schema<ElfConfig>({
  type: "object",
  properties: {
    rootDir: { type: "string" },
    openaiApiKey: { type: "optional", inner: { type: "string" } },
    anthropicApiKey: { type: "optional", inner: { type: "string" } },
  },
});

export class Elf {
  // All set in `run()`, before the first await — the elf is unusable until then.
  private config!: ElfConfig;
  private elfDir!: string;
  private agent!: Agent;
  private functionManager!: FunctionManager;
  private peerManager!: PeerManager;
  private spawnManager!: SpawnManager;
  private portsManager!: PortsManager;
  private database!: Database;
  private notesManager!: NotesManager;

  /**
   * Entry point for the top-of-tree elf: read config, ensure the root work dir,
   * then run the elf alongside a stdin REPL that feeds the user's lines to its
   * agent.
   */
  async runRootElf() {
    console.log(`Launching root elf`);

    const config = await this.readConfigFile();
    console.log(`Loaded config...`);

    await this.createWorkDir(config.rootDir);
    await Promise.all([
      this.run(config, config.rootDir, ROOT_PURPOSE),
      // TODO - should the CLI just be a peer we register for root? Probs,
      // and calls built-in func for sending a msg to the agent.
      runCli((message) => this.agent.ask(message)),
    ]);
  }

  /**
   * Boot this elf in `elfDir`: construct and start every component, reconnect to
   * the parent (if forked), restore child elves + ports, then run the agent loop.
   * If `purpose` is provided and no Purpose note exists yet, it is written now.
   */
  async run(config: ElfConfig, elfDir: string, purpose?: string) {
    console.log(`Running an elf in ${elfDir}!`);
    process.chdir(elfDir);
    this.config = config;
    this.elfDir = elfDir;

    // Construct all managers synchronously first (no awaits), then build the
    // agent with tools that close over them. Everything is still set before the
    // first await, so a racing CLI or peer message can't find an unset field.
    this.functionManager = new FunctionManager(elfDir);
    this.peerManager = new PeerManager(elfDir, this.functionManager);
    this.database = new Database(elfDir);
    this.notesManager = new NotesManager(elfDir);
    this.spawnManager = new SpawnManager({
      childrenDir: path.join(elfDir, "children"),
      entryScript: ENTRY_SCRIPT,
      peerManager: this.peerManager,
      initPayload: (childDir, purpose) => ({ config, elfDir: childDir, purpose }),
    });
    this.portsManager = new PortsManager(elfDir, this.peerManager, this.functionManager);

    this.agent = Agent.createAgent(config, [
      ...functionManagerTools(this.functionManager),
      ...databaseTools(this.database),
      ...notesManagerTools(this.notesManager),
      ...peerManagerTools(this.peerManager),
      ...portsManagerTools(this.portsManager),
      ...spawnManagerTools(this.spawnManager),
    ], ELF_SYSTEM_PROMPT);

    // Restore persisted state. FunctionManager first so the interface bindings
    // PeerManager loads resolve against functions that already exist.
    await this.functionManager.start();
    await this.peerManager.start();
    await this.database.start();
    await this.notesManager.start();
    if (purpose && !this.notesManager.getNote("Purpose")) {
      await this.notesManager.setNote("Purpose", purpose);
    }
    await this.portsManager.start();
    this.registerSyscalls();

    // If we were forked, the same IPC channel that delivered our init message is
    // the edge back to our parent — adopt it as a peer like any other.
    if (process.send) {
      await this.peerManager.attachPeer(
        PARENT_PEER,
        // `process` exposes send/on/off but its chainable `on` returns Process,
        // not ChildProcess, so the structural match needs an explicit cast.
        (callbacks) => new IpcPeer(process as unknown as IpcChannel, callbacks),
      );
    }

    // Bring the world back up where we left off.
    await this.spawnManager.spawnAllExisting();
    await this.portsManager.openAllExisting();

    // Queue a startup message before the loop begins so the agent boots into
    // its purpose without waiting for external input.
    void this.agent.ask(
      "You have just started. Read your Purpose, Memory, and Tasks notes, then carry out your purpose.",
    );
    await this.agent.runAgentLoop();
  }

  /**
   * Register all built-in syscalls. Called once in run() after every manager is
   * started, so the lambdas can safely call into db, peers, etc. on first use.
   */
  private registerSyscalls(): void {
    const fm = this.functionManager;

    // ---- Database ----

    fm.registerSyscall(
      "db_set",
      schemaObj({ key: schemaStr(), value: schemaStr() }),
      schemaVoid(),
      async (input) => {
        const { key, value } = input as { key: string; value: string };
        await this.database.setValue(key, value);
        return {};
      },
    );

    fm.registerSyscall(
      "db_get",
      schemaObj({ key: schemaStr() }),
      schemaResult(schemaStr()),
      async (input) => {
        const { key } = input as { key: string };
        return this.database.getValue(key);
      },
    );

    fm.registerSyscall(
      "db_delete",
      schemaObj({ key: schemaStr() }),
      schemaVoid(),
      async (input) => {
        const { key } = input as { key: string };
        await this.database.deleteValue(key);
        return {};
      },
    );

    fm.registerSyscall(
      "db_list_keys",
      schemaObj({ prefix: schemaStr() }),
      schemaResult(schemaArr(schemaStr())),
      async (input) => {
        const { prefix } = input as { prefix: string };
        return this.database.listKeysWithPrefix(prefix);
      },
    );

    // ---- Peers ----

    fm.registerSyscall(
      "call_peer",
      schemaObj({ peer: schemaStr(), func: schemaStr(), input: schemaAny() }),
      schemaResult(schemaAny()),
      async (input) => {
        const { peer, func, input: callInput } = input as { peer: string; func: string; input: unknown };
        const result = await this.peerManager.callPeer(peer, func, JSON.stringify(callInput));
        if (!result.ok) return result;
        return { ok: true, value: JSON.parse(result.value) };
      },
    );

    // ---- Local functions ----

    fm.registerSyscall(
      "call_func",
      schemaObj({ name: schemaStr(), input: schemaAny() }),
      schemaResult(schemaAny()),
      async (input) => {
        const { name, input: funcInput } = input as { name: string; input: unknown };
        const result = await this.functionManager.executeFunc(name, JSON.stringify(funcInput));
        if (!result.ok) return result;
        return { ok: true, value: JSON.parse(result.value) };
      },
    );

    // ---- Agent ----

    // Note: calling this from a function triggered by the agent will deadlock,
    // since the agent loop processes one turn at a time. Safe to use from
    // peer-initiated or autonomously-running functions.
    fm.registerSyscall(
      "ask_agent",
      schemaObj({ message: schemaStr() }),
      schemaObj({ response: schemaStr() }),
      async (input) => {
        const { message } = input as { message: string };
        const response = await this.agent.ask(message);
        return { response };
      },
    );
  }

  /**
   * Ensure the work directory at `dirPath` exists. No-op if already present.
   * (Child work dirs are created by SpawnManager; this is for the root elf.)
   */
  async createWorkDir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
  }

  private async readConfigFile(): Promise<ElfConfig> {
    const configPath = path.join(process.cwd(), "config.json");
    const raw = await readFile(configPath, "utf8");
    return ElfConfigSchema.parse(JSON.parse(raw));
  }
}
