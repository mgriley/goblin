import type { ObjectSchema } from "../schema.js";

// The JSON Schema subset used to describe tool parameters lives in
// `../schema.js` (it doubles as our validation + peer-advertisement format).
// Re-exported here so existing `llm.js` importers keep working.
export type { JsonSchema, ObjectSchema } from "../schema.js";

export type Role = "system" | "user" | "assistant" | "tool";

/** A tool invocation requested by the assistant. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A single message in a conversation.
 *
 * `toolCalls` is set on assistant messages that invoke tools.
 * `toolCallId` is set on `tool`-role messages to reference the call they answer.
 */
export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

/** Tool the model is allowed to call. `parameters` is always an object schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ObjectSchema;
}

/** A `ToolDefinition` plus the async handler that runs when the model invokes it. */
export interface Tool extends ToolDefinition {
  handler: (args: Record<string, unknown>) => Promise<string>;
}

/** Result of a single `LLM.complete` turn. */
export interface LLMResponse {
  text: string;
  toolCalls?: ToolCall[];
}

/** Provider-agnostic chat LLM. */
export interface LLM {
  complete(input: {
    messages: Message[];
    tools?: ToolDefinition[];
  }): Promise<LLMResponse>;
}
