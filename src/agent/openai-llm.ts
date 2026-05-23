import process from "node:process";

import type {
  LLM,
  LLMResponse,
  Message,
  ToolCall,
  ToolDefinition,
} from "./llm.js";

export interface OpenAILLMOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** OpenAI Chat Completions implementation of `LLM`. Uses built-in `fetch`. */
export class OpenAILLM implements LLM {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: OpenAILLMOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAILLM: missing API key (pass `apiKey` or set OPENAI_API_KEY).",
      );
    }
    this.apiKey = apiKey;
    this.model = options.model ?? "gpt-4o-mini";
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  }

  async complete(input: {
    messages: Message[];
    tools?: ToolDefinition[];
  }): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: input.messages.map(toOpenAIMessage),
    };
    if (input.tools?.length) {
      body.tools = input.tools.map(toOpenAITool);
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI request failed (${response.status}): ${await response.text()}`,
      );
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const message = data.choices[0]?.message;
    if (!message) {
      throw new Error("OpenAI response had no message in choices[0].");
    }

    const toolCalls = message.tool_calls?.map(fromOpenAIToolCall);
    return {
      text: message.content ?? "",
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}

interface OpenAIChatResponse {
  choices: {
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }[];
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function toOpenAIMessage(message: Message): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function fromOpenAIToolCall(raw: OpenAIToolCall): ToolCall {
  let args: Record<string, unknown>;
  try {
    args = raw.function.arguments ? JSON.parse(raw.function.arguments) : {};
  } catch (err) {
    throw new Error(
      `Failed to parse tool call arguments for ${raw.function.name}: ${(err as Error).message}`,
    );
  }
  return { id: raw.id, name: raw.function.name, arguments: args };
}
