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
 *     | literal | union
 *   - object:   properties (all required)
 *   - array:    items
 *   - optional: inner — value satisfies the inner schema, or is null (the only
 *     place null is accepted)
 *   - literal:  value — strictly equals a fixed string/number/boolean. Pairs
 *     with union to discriminate arms (e.g. `ok: true` vs `ok: false`).
 *   - union:    anyOf — value satisfies at least one of the listed schemas;
 *     variants are tried in order and the first match wins. With a literal
 *     discriminator this expresses `Result<T>` (see utils.ts).
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

/** Matches one fixed primitive value, by strict equality. */
export interface LiteralSchema extends BaseSchema {
  type: "literal";
  value: string | number | boolean;
}

/** Value must satisfy at least one of `anyOf`; variants are tried in order. */
export interface UnionSchema extends BaseSchema {
  type: "union";
  anyOf: JsonSchema[];
}

/**
 * A plain object with arbitrary string keys, all values conforming to `values`.
 * Unlike {@link ObjectSchema}, the key set is not fixed: all present keys pass
 * through (none are dropped, none are required). Useful for headers, query-param
 * bags, or any `Record<string, V>` shape.
 */
export interface MapSchema extends BaseSchema {
  type: "map";
  values: JsonSchema;
}

/** Accepts any value and passes it through unchanged — no validation performed. */
export interface AnySchema extends BaseSchema {
  type: "any";
}

export type JsonSchema =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | ArraySchema
  | ObjectSchema
  | OptionalSchema
  | LiteralSchema
  | UnionSchema
  | MapSchema
  | AnySchema;

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
    case "any":
      return value;
    case "optional":
      return value === null ? null : validate(schema.inner, value, path);
    case "literal":
      if (value !== schema.value) {
        throw new SchemaError(path, `expected ${JSON.stringify(schema.value)}`);
      }
      return value;
    case "union":
      return validateUnion(schema, value, path);
    case "object":
      return validateObject(schema, value, path);
    case "map":
      return validateMap(schema, value, path);
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

function validateUnion(schema: UnionSchema, value: unknown, path: string): unknown {
  const failures: string[] = [];
  for (const variant of schema.anyOf) {
    try {
      return validate(variant, value, path);
    } catch (err) {
      // Strict, no-coercion variants: a failure just means "not this arm". Keep
      // the detail so the aggregate error can explain why nothing matched.
      failures.push(err instanceof SchemaError ? err.message : String(err));
    }
  }
  throw new SchemaError(
    path,
    `no union variant matched (${failures.join("; ")})`,
  );
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
      if (sub.type === "optional") {
        out[key] = undefined;
        continue;
      }
      throw new SchemaError(childPath, "required property missing");
    }
    out[key] = validate(sub, input[key], childPath);
  }

  return out;
}

function validateMap(
  schema: MapSchema,
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SchemaError(path, "expected map");
  }
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    out[key] = validate(schema.values, val, `${path}["${key}"]`);
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

/**
 * Convert our internal {@link JsonSchema} dialect to standard JSON Schema
 * draft 2020-12, suitable for use as an LLM tool `input_schema`.
 *
 * Our dialect adds types that have no direct JSON Schema equivalent:
 *   - `optional`  → property is omitted from the parent object's `required`
 *                   array; the inner schema is used as the property schema.
 *   - `union`     → `anyOf`
 *   - `literal`   → `const`
 *   - `map`       → `{ type: "object", additionalProperties: <values schema> }`
 *   - `any`       → `{}` (empty schema accepts everything)
 */
export function toStandardJsonSchema(schema: JsonSchema): Record<string, unknown> {
  switch (schema.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean": {
      const r: Record<string, unknown> = { type: schema.type };
      if (schema.description) r.description = schema.description;
      return r;
    }
    case "array": {
      const r: Record<string, unknown> = { type: "array", items: toStandardJsonSchema(schema.items) };
      if (schema.description) r.description = schema.description;
      return r;
    }
    case "object": {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (sub.type === "optional") {
          const inner = toStandardJsonSchema(sub.inner);
          const desc = sub.description ?? sub.inner.description;
          if (desc) (inner as Record<string, unknown>).description = desc;
          properties[key] = inner;
        } else {
          properties[key] = toStandardJsonSchema(sub);
          required.push(key);
        }
      }
      const r: Record<string, unknown> = { type: "object", properties };
      if (required.length) r.required = required;
      if (schema.description) r.description = schema.description;
      return r;
    }
    case "optional":
      return toStandardJsonSchema(schema.inner);
    case "union": {
      const r: Record<string, unknown> = { anyOf: schema.anyOf.map(toStandardJsonSchema) };
      if (schema.description) r.description = schema.description;
      return r;
    }
    case "literal": {
      const r: Record<string, unknown> = { const: schema.value };
      if (schema.description) r.description = schema.description;
      return r;
    }
    case "map": {
      const r: Record<string, unknown> = { type: "object", additionalProperties: toStandardJsonSchema(schema.values) };
      if (schema.description) r.description = schema.description;
      return r;
    }
    case "any": {
      const r: Record<string, unknown> = {};
      if (schema.description) r.description = schema.description;
      return r;
    }
  }
}
