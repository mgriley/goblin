import { AnthropicLLM } from "./anthropic-llm.js";
import { AsyncQueue } from "./async-queue.js";
import type { ElfConfig } from "./elf-lib.js";
import type { LLM, Message } from "./llm.js";
import { OpenAILLM } from "./openai-llm.js";

interface InboxItem {
  message: string;
  resolve: (response: string) => void;
  reject: (err: Error) => void;
}

export class Agent {
  private readonly llm: LLM;
  private readonly history: Message[] = [];
  private readonly inbox = new AsyncQueue<InboxItem>();

  constructor(llm: LLM) {
    this.llm = llm;
  }

  /**
   * Build an Agent from an `ElfConfig`. Anthropic is preferred when both
   * keys are present; throws if neither is set.
   */
  static createAgent(config: ElfConfig): Agent {
    if (config.anthropicApiKey) {
      return new Agent(new AnthropicLLM({ apiKey: config.anthropicApiKey }));
    }
    if (config.openaiApiKey) {
      return new Agent(new OpenAILLM({ apiKey: config.openaiApiKey }));
    }
    throw new Error(
      "Agent.createAgent: ElfConfig must include anthropicApiKey or openaiApiKey.",
    );
  }

  /**
   * Send `message` as a user turn and resolve with the LLM's reply text.
   * Calls are serialized through the inbox — concurrent `ask`s run one at a
   * time so the shared history isn't mutated mid-call.
   */
  async ask(message: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.inbox.push({ message, resolve, reject });
    });
  }

  /** Forever: take next inbox item, send to the LLM, resolve the caller. */
  async runAgentLoop(): Promise<void> {
    console.log(`Running the agent loop! Waiting for messages...`);
    while (true) {
      const item = await this.inbox.pop();
      try {
        this.history.push({ role: "user", content: item.message });

        const response = await this.llm.complete({ messages: this.history });

        const assistantMessage: Message = {
          role: "assistant",
          content: response.text,
        };
        if (response.toolCalls?.length) {
          assistantMessage.toolCalls = response.toolCalls;
        }
        this.history.push(assistantMessage);

        console.log(`[agent] ${response.text}`);
        item.resolve(response.text);
      } catch (err) {
        item.reject(err as Error);
      }
    }
  }
}
