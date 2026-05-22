import { AsyncQueue } from "./async-queue.js";
import type { LLM, Message } from "./llm.js";

export class Agent {
  private readonly llm: LLM;
  private readonly history: Message[] = [];
  private readonly inbox = new AsyncQueue<string>();

  constructor(llm: LLM) {
    this.llm = llm;
  }

  /** Append a message to the inbox; runAgentLoop will pick it up. */
  async queueMessage(message: string): Promise<void> {
    this.inbox.push(message);
  }

  /** Forever: take next inbox message, send to the LLM, store the reply. */
  async runAgentLoop(): Promise<void> {
    while (true) {
      const incoming = await this.inbox.pop();
      this.history.push({ role: "user", content: incoming });

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
    }
  }
}
