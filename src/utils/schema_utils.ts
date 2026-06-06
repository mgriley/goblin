/**
 * Compact builders for {@link JsonSchema} JSON. Hand-writing the nested object
 * literals is verbose and easy to get subtly wrong (a misplaced `type`, a
 * forgotten `items`); these functions let you express the same schema as a
 * nested call tree that reads like the shape it describes:
 *
 *   schemaObj({ name: schemaStr(), tags: schemaArr(schemaStr()) })
 *
 * Each builder is prefixed `schema*` and returns plain JSON (the canonical,
 * portable form) — not a {@link Schema} — so the results nest freely inside one
 * another and inside a hand-written literal. Wrap the outermost result in
 * `new Schema<T>(...)` (or use {@link resultSchema}) for validate/parse.
 */

import {
  Schema,
  type AnySchema,
  type ArraySchema,
  type BooleanSchema,
  type JsonSchema,
  type LiteralSchema,
  type MapSchema,
  type NumberSchema,
  type ObjectSchema,
  type OptionalSchema,
  type StringSchema,
  type UnionSchema,
} from "./schema.js";
import type { Result } from "./utils.js";

/** Schema for a string. */
export function schemaStr(): StringSchema {
  return { type: "string" };
}

/** Schema for any finite number. */
export function schemaNum(): NumberSchema {
  return { type: "number" };
}

/** Schema for an integer. */
export function schemaInt(): NumberSchema {
  return { type: "integer" };
}

/** Schema for a boolean. */
export function schemaBool(): BooleanSchema {
  return { type: "boolean" };
}

/** Schema for an array whose every element satisfies `items`. */
export function schemaArr(items: JsonSchema): ArraySchema {
  return { type: "array", items };
}

/** Schema for an object; every listed property is required. */
export function schemaObj(properties: Record<string, JsonSchema>): ObjectSchema {
  return { type: "object", properties };
}

/** Schema for an object with arbitrary string keys, all values satisfying `values`. */
export function schemaMap(values: JsonSchema): MapSchema {
  return { type: "map", values };
}

/** Schema accepting `inner` or `null`. */
export function schemaOptional(inner: JsonSchema): OptionalSchema {
  return { type: "optional", inner };
}

/** Schema that accepts any value and passes it through unchanged. */
export function schemaAny(): AnySchema {
  return { type: "any" };
}

/** Alias for {@link schemaAny} — use for syscalls/functions that return nothing meaningful. */
export function schemaVoid(): AnySchema {
  return { type: "any" };
}

/** Schema matching exactly `value` (strict equality). */
export function schemaLiteral(value: string | number | boolean): LiteralSchema {
  return { type: "literal", value };
}

/** Schema satisfied by any one of `variants`, tried in order. */
export function schemaUnion(...variants: JsonSchema[]): UnionSchema {
  return { type: "union", anyOf: variants };
}

/** Attach human/LLM-facing documentation to any schema, returning a copy. */
export function schemaDescribe<T extends JsonSchema>(
  schema: T,
  description: string,
): T {
  return { ...schema, description };
}

/**
 * Schema for a {@link Result}<T>: `{ ok: true, value }` on success or
 * `{ ok: false, error }` on failure, where `value` satisfies `valueSchema`. The
 * `ok` literal discriminates the arms, so a mismatched payload is rejected.
 */
export function schemaResult(valueSchema: JsonSchema): UnionSchema {
  return schemaUnion(
    schemaObj({ ok: schemaLiteral(true), value: valueSchema }),
    schemaObj({ ok: schemaLiteral(false), error: schemaStr() }),
  );
}

/** {@link schemaResult} wrapped in a {@link Schema} for direct parse/validate. */
export function resultSchema<T>(valueSchema: JsonSchema): Schema<Result<T>> {
  return new Schema<Result<T>>(schemaResult(valueSchema));
}
