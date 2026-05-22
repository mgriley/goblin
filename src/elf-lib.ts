import { fork, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { Agent } from "./agent.js";
import { runCli } from "./cli.js";
import { Messenger, type MessageSource } from "./messenger.js";
import { ROOT_PURPOSE } from "./root_purpose.js";
import { checkIfDirExists, findAllSubdirs } from "./utils.js";

// Path to main.{js,ts} sitting next to this file. The extension follows our
// current runtime: `.js` when running compiled output, `.ts` under tsx.
const HERE = fileURLToPath(import.meta.url);
const ENTRY_SCRIPT = path.join(path.dirname(HERE), `main${path.extname(HERE)}`);

export type ElfId = string;

export const ElfConfigSchema = z.object({
  rootDir: z.string(),
  openaiApiKey: z.string().optional(),
  anthropicApiKey: z.string().optional(),
});

export type ElfConfig = z.infer<typeof ElfConfigSchema>;

class ChildInfo {
  constructor(
    public readonly process: ChildProcess,
    public readonly elfDir: string,
  ) {}
}

export class Elf {
  private children: Map<ElfId, ChildInfo>;
  private messenger: Messenger;
  // Set in `run()`; available to anything called after the elf has started.
  private config!: ElfConfig;
  private elfDir!: string;
  private agent!: Agent;

  constructor() {
    this.children = new Map<ElfId, ChildInfo>();
    this.messenger = new Messenger((source, message) =>
      this.handleMessage(source, message),
    );
  }

  async runRootElf() {
    console.log(`Launching root elf`);

    const config = await this.readConfigFile();
    console.log(`Loaded config...`);

    // Create the root elf's work dir, then run it alongside the user CLI.
    await this.createWorkDir(config.rootDir, ROOT_PURPOSE);
    await Promise.all([
      this.run(config, config.rootDir),
      runCli((message) =>
        this.handleMessage({ type: "parentMessage" }, message),
      ),
    ]);
  }

  async run(config: ElfConfig, elfDir: string) {
    console.log(`Running an elf in ${elfDir}!`);
    process.chdir(elfDir);
    this.config = config;
    this.elfDir = elfDir;
    // Construct the agent before any await so handleMessage can't race
    // against an unset field if a message lands while we're booting.
    this.agent = Agent.createAgent(config);

    // Launch each child elf — one per subdirectory under `./children`.
    // TODO - should probably be run as a tool, part of the first instruction.
    for (const childDir of await findAllSubdirs(path.join(elfDir, "children"))) {
      await this.startChild(config, childDir);
    }

    // TODO - feed it a first instruction.
    await this.agent.runAgentLoop();
  }

  private async handleMessage(
    source: MessageSource,
    message: string,
  ): Promise<string> {
    const from =
      source.type === "parentMessage" ? "parent" : (source.childName ?? "?");
    console.log(`[elf] message from ${from}: ${message}`);
    return this.agent.ask(message);
  }

  async createChild(childName: string, purpose: string): Promise<void> {
    if (this.children.has(childName)) {
      throw new Error(`createChild: child with name "${childName}" already exists`);
    }
    const childDir = path.join(this.elfDir, "children", childName);
    await this.createWorkDir(childDir, purpose);
    await this.startChild(this.config, childDir);
  }

  async startChild(config: ElfConfig, elfDir: string) {
    console.log(`Starting child elf in ${elfDir}...`);

    // Fork the same entry script. If we're under tsx (.ts), pass the loader
    // so the child can require .ts sources too.
    const execArgv =
      path.extname(ENTRY_SCRIPT) === ".ts" ? ["--import", "tsx"] : [];
    const childProc = fork(ENTRY_SCRIPT, [], { execArgv });

    // Hand the child its config + workspace dir over IPC. Node buffers this
    // until the child's event loop starts, so a `process.once("message")` on
    // the child side will receive it.
    childProc.send({ config, elfDir });

    const elfId = path.basename(elfDir);
    this.children.set(elfId, new ChildInfo(childProc, elfDir));
    this.messenger.attachChild(elfId, childProc);

    childProc.on("exit", (code, signal) => {
      // TODO - let the agent know
      console.log(
        `[elf] child ${elfId} exited (code=${code}, signal=${signal})`,
      );
      this.children.delete(elfId);
    });
    childProc.on("error", (err) => {
      // TODO - let the agent know
      console.error(`[elf] child ${elfId} error:`, err);
    });
  }

  async deleteChild(elfId: ElfId) {
    const child = this.children.get(elfId);
    if (!child) {
      console.warn(`deleteChild: no child elf with id ${elfId}`);
      return;
    }

    // If still alive, SIGTERM it and wait for the exit event before returning.
    if (child.process.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.process.once("exit", () => resolve());
        child.process.kill();
      });
    }

    this.children.delete(elfId);
  }

  async sendMessageToChild(
    elfId: ElfId,
    message: string,
  ): Promise<string | undefined> {
    const child = this.children.get(elfId);
    if (!child) {
      console.warn(`sendMessageToChild: no child elf with id ${elfId}`);
      return;
    }
    return this.messenger.sendMessage(child.process, message);
  }

  async sendMessageToParent(message: string): Promise<string | undefined> {
    if (!process.send) {
      console.warn(`sendMessageToParent: no parent (this elf was not forked)`);
      return;
    }
    return this.messenger.sendMessage(process, message);
  }

  /**
   * Create a fresh work directory at `dirPath` containing a `purpose.md`
   * file with the given contents. If `dirPath` already exists, no-op.
   */
  async createWorkDir(dirPath: string, purpose: string): Promise<void> {
    if (await checkIfDirExists(dirPath)) return;
    await mkdir(dirPath, { recursive: true });
    await writeFile(path.join(dirPath, "purpose.md"), purpose);
  }

  private async readConfigFile(): Promise<ElfConfig> {
    const configPath = path.join(process.cwd(), "config.json");
    const raw = await readFile(configPath, "utf8");
    return ElfConfigSchema.parse(JSON.parse(raw));
  }
}
