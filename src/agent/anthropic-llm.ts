import process from "node:process";

import type {
  LLM,
  LLMResponse,
  Message,
  ToolCall,
  ToolDefinition,
} from "./llm.js";
import { toStandardJsonSchema } from "../utils/schema.js";

export interface AnthropicLLMOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Required by the Messages API; defaults to 4096. */
  maxTokens?: number;
  /** Value for the `anthropic-version` header. */
  anthropicVersion?: string;
}

/** Anthropic Messages API implementation of `LLM`. Uses built-in `fetch`. */
export class AnthropicLLM implements LLM {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly anthropicVersion: string;

  constructor(options: AnthropicLLMOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "AnthropicLLM: missing API key (pass `apiKey` or set ANTHROPIC_API_KEY).",
      );
    }
    this.apiKey = apiKey;
    this.model = options.model ?? "claude-sonnet-4-6";
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";
    this.maxTokens = options.maxTokens ?? 4096;
    this.anthropicVersion = options.anthropicVersion ?? "2023-06-01";
  }

  async complete(input: {
    messages: Message[];
    tools?: ToolDefinition[];
  }): Promise<LLMResponse> {
    const { system, messages } = toAnthropicMessages(input.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
    };
    if (system) body.system = system;
    if (input.tools?.length) {
      body.tools = input.tools.map(toAnthropicTool);
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic request failed (${response.status}): ${await response.text()}`,
      );
    }

    const data = (await response.json()) as AnthropicResponse;
    return fromAnthropicResponse(data);
  }
}

interface AnthropicResponse {
  content: AnthropicResponseBlock[];
  stop_reason?: string;
}

type AnthropicResponseBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicRequestBlock[];
}

type AnthropicRequestBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_result"; tool_use_id: string; content: string };

/**
 * Convert our flat `Message[]` into Anthropic's shape:
 * - `system` messages are extracted into a separate top-level string.
 * - `tool` messages become user-role `tool_result` blocks.
 * - Consecutive same-role messages are merged into one (Anthropic requires
 *   strict user/assistant alternation).
 */
function toAnthropicMessages(messages: Message[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }

    const blocks = messageToBlocks(msg);
    if (blocks.length === 0) continue;

    const targetRole: "user" | "assistant" =
      msg.role === "assistant" ? "assistant" : "user";
    const last = out[out.length - 1];
    if (last && last.role === targetRole) {
      last.content.push(...blocks);
    } else {
      out.push({ role: targetRole, content: blocks });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

function messageToBlocks(msg: Message): AnthropicRequestBlock[] {
  if (msg.role === "tool") {
    if (!msg.toolCallId) {
      throw new Error("AnthropicLLM: tool-role message missing toolCallId.");
    }
    return [
      {
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: msg.content,
      },
    ];
  }

  const blocks: AnthropicRequestBlock[] = [];
  if (msg.content) {
    blocks.push({ type: "text", text: msg.content });
  }
  if (msg.role === "assistant" && msg.toolCalls?.length) {
    for (const c of msg.toolCalls) {
      blocks.push({
        type: "tool_use",
        id: c.id,
        name: c.name,
        input: c.arguments,
      });
    }
  }
  return blocks;
}

function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: toStandardJsonSchema(tool.parameters),
  };
}

function fromAnthropicResponse(data: AnthropicResponse): LLMResponse {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of data.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
    }
  }
  return {
    text: textParts.join(""),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}
