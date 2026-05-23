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

// ---------------------------------------------------------------------------
// JSON Schema subset used to describe tool parameters. Both OpenAI and
// Anthropic accept JSON Schema directly, so these types double as the
// wire format — no conversion is needed beyond field-name differences.
// ---------------------------------------------------------------------------

export interface JSONSchemaObject {
  type: "object";
  properties?: Record<string, JSONSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  description?: string;
}

export interface JSONSchemaString {
  type: "string";
  description?: string;
  enum?: readonly string[];
}

export interface JSONSchemaNumber {
  type: "number" | "integer";
  description?: string;
}

export interface JSONSchemaBoolean {
  type: "boolean";
  description?: string;
}

export interface JSONSchemaArray {
  type: "array";
  items: JSONSchema;
  description?: string;
}

export type JSONSchema =
  | JSONSchemaObject
  | JSONSchemaString
  | JSONSchemaNumber
  | JSONSchemaBoolean
  | JSONSchemaArray;

/** Tool the model is allowed to call. `parameters` is always an object schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchemaObject;
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
