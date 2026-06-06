import { AsyncQueue } from "../utils/async-queue.js";
import type { ElfConfig } from "../elf.js";
import type { LLM, Message, Tool, ToolCall } from "./llm.js";
import { AnthropicLLM } from "./anthropic-llm.js";
import { OpenAILLM } from "./openai-llm.js";

interface InboxItem {
  message: string;
  resolve: (response: string) => void;
  reject: (err: Error) => void;
}

export class Agent {
  private readonly llm: LLM;
  private readonly tools: Tool[];
  private readonly toolsByName: Map<string, Tool>;
  private readonly history: Message[];
  private readonly inbox = new AsyncQueue<InboxItem>();

  constructor(llm: LLM, tools: Tool[] = [], systemPrompt?: string) {
    this.llm = llm;
    this.tools = tools;
    this.toolsByName = new Map(tools.map((t) => [t.name, t]));
    this.history = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  }

  /**
   * Build an Agent from an `ElfConfig`. Anthropic is preferred when both
   * keys are present; throws if neither is set.
   */
  static createAgent(config: ElfConfig, tools: Tool[] = [], systemPrompt?: string): Agent {
    if (config.anthropicApiKey) {
      return new Agent(
        new AnthropicLLM({ apiKey: config.anthropicApiKey }),
        tools,
        systemPrompt,
      );
    }
    if (config.openaiApiKey) {
      return new Agent(new OpenAILLM({ apiKey: config.openaiApiKey }), tools, systemPrompt);
    }
    throw new Error(
      "Agent.createAgent: ElfConfig must include anthropicApiKey or openaiApiKey.",
    );
  }

  /**
   * Send `message` as a user turn and resolve with the LLM's final reply.
   * Calls are serialized through the inbox — concurrent `ask`s run one at a
   * time so the shared history isn't mutated mid-call.
   */
  async ask(message: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.inbox.push({ message, resolve, reject });
    });
  }

  /**
   * Forever: take next inbox item, drive a request→tool→response loop until
   * the model returns text with no further tool calls, then resolve.
   */
  async runAgentLoop(): Promise<void> {
    console.log(`Running the agent loop! Waiting for messages...`);
    while (true) {
      const item = await this.inbox.pop();
      try {
        this.history.push({ role: "user", content: item.message });
        const finalText = await this.runToolLoop();
        item.resolve(finalText);
      } catch (err) {
        item.reject(err as Error);
      }
    }
  }

  /**
   * Keep calling the LLM, executing any tool calls in parallel and feeding
   * results back, until the model returns a turn with no tool calls.
   */
  private async runToolLoop(): Promise<string> {
    while (true) {
      const response = await this.llm.complete({
        messages: this.history,
        ...(this.tools.length > 0 ? { tools: this.tools } : {}),
      });

      const assistantMessage: Message = {
        role: "assistant",
        content: response.text,
      };
      if (response.toolCalls?.length) {
        assistantMessage.toolCalls = response.toolCalls;
      }
      this.history.push(assistantMessage);

      if (!response.toolCalls?.length) {
        return response.text;
      }

      // Run every requested tool concurrently; append each result as a
      // `tool`-role message correlated to its toolCallId.
      const results = await Promise.all(
        response.toolCalls.map((call) => this.executeTool(call)),
      );
      for (let i = 0; i < response.toolCalls.length; i++) {
        const call = response.toolCalls[i]!;
        this.history.push({
          role: "tool",
          content: results[i]!,
          toolCallId: call.id,
        });
      }
    }
  }

  private async executeTool(call: ToolCall): Promise<string> {
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      return `Error: unknown tool "${call.name}".`;
    }
    try {
      return await tool.handler(call.arguments);
    } catch (err) {
      return `Error executing "${call.name}": ${(err as Error).message}`;
    }
  }
}
