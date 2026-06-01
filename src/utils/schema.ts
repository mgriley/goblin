/**
 * A tiny, dependency-free subset of JSON Schema, plus a validator.
 *
 * The canonical schema is a plain JSON object: it ports to any language and
 * doubles as the wire format for advertising an interface to a peer (no
 * serialization step needed). The `Schema` class is a thin TypeScript
 * ergonomics wrapper around that object; the portable logic lives in the
 * standalone `validate()` function.
 *
 * Supported keywords (intentionally small — extend only when needed):
 *   - type: object | array | string | number | integer | boolean | optional
 *   - object:   properties (all required)
 *   - array:    items
 *   - optional: inner — value satisfies the inner schema, or is null (the only
 *     place null is accepted)
 */

interface BaseSchema {
  /** Human/LLM-facing documentation. Ignored during validation. */
  description?: string;
}

export interface StringSchema extends BaseSchema {
  type: "string";
}

export interface NumberSchema extends BaseSchema {
  type: "number" | "integer";
}

export interface BooleanSchema extends BaseSchema {
  type: "boolean";
}

export interface ArraySchema extends BaseSchema {
  type: "array";
  items: JsonSchema;
}

export interface ObjectSchema extends BaseSchema {
  type: "object";
  /** Every listed property is required. */
  properties: Record<string, JsonSchema>;
}

/** Wraps another schema to also accept `null`. */
export interface OptionalSchema extends BaseSchema {
  type: "optional";
  inner: JsonSchema;
}

export type JsonSchema =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | ArraySchema
  | ObjectSchema
  | OptionalSchema;

/** Thrown on the first validation failure, carrying the path to the bad value. */
export class SchemaError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "SchemaError";
  }
}

/**
 * Validate `value` against `schema`. Performs strict type checking with no
 * coercion (a string is never accepted where a number is expected). Throws
 * `SchemaError` on the first failure.
 */
export function validate(
  schema: JsonSchema,
  value: unknown,
  path = "$",
): unknown {
  switch (schema.type) {
    case "optional":
      return value === null ? null : validate(schema.inner, value, path);
    case "object":
      return validateObject(schema, value, path);
    case "array":
      return validateArray(schema, value, path);
    case "string":
      if (typeof value !== "string") throw new SchemaError(path, "expected string");
      return value;
    case "number":
    case "integer":
      return validateNumber(schema, value, path);
    case "boolean":
      if (typeof value !== "boolean") throw new SchemaError(path, "expected boolean");
      return value;
  }
}

function validateNumber(schema: NumberSchema, value: unknown, path: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new SchemaError(path, "expected number");
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    throw new SchemaError(path, "expected integer");
  }
  return value;
}

function validateArray(schema: ArraySchema, value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new SchemaError(path, "expected array");
  return value.map((item, i) => validate(schema.items, item, `${path}[${i}]`));
}

function validateObject(
  schema: ObjectSchema,
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SchemaError(path, "expected object");
  }
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, sub] of Object.entries(schema.properties)) {
    const childPath = `${path}.${key}`;
    if (!(key in input) || input[key] === undefined) {
      throw new SchemaError(childPath, "required property missing");
    }
    out[key] = validate(sub, input[key], childPath);
  }

  return out;
}

/** Result of {@link Schema.safeParse}. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Ergonomic wrapper around a {@link JsonSchema}. The type parameter `T` lets
 * callers annotate the expected output shape (it is not inferred from the
 * schema — hand-write the matching TS type, e.g. `new Schema<ElfConfig>(...)`).
 */
export class Schema<T = unknown> {
  constructor(readonly definition: JsonSchema) {}

  /** Validate and return the normalized value. Throws `SchemaError` on failure. */
  parse(value: unknown): T {
    return validate(this.definition, value) as T;
  }

  /** Non-throwing variant of {@link parse}. */
  safeParse(value: unknown): ParseResult<T> {
    try {
      return { ok: true, value: validate(this.definition, value) as T };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** True if `value` conforms to the schema. */
  isValid(value: unknown): boolean {
    return this.safeParse(value).ok;
  }

  /** The raw JSON Schema object — portable and safe to send to a peer. */
  toJSON(): JsonSchema {
    return this.definition;
  }
}
