import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Schema,
  SchemaError,
  validate,
  type JsonSchema,
} from "./schema.js";

describe("validate — strings", () => {
  it("accepts strings", () => {
    assert.equal(validate({ type: "string" }, "hi"), "hi");
    assert.equal(validate({ type: "string" }, ""), "");
  });

  it("rejects non-strings", () => {
    assert.throws(() => validate({ type: "string" }, 1), SchemaError);
    assert.throws(() => validate({ type: "string" }, null), SchemaError);
    assert.throws(() => validate({ type: "string" }, undefined), SchemaError);
  });
});

describe("validate — numbers", () => {
  it("accepts numbers", () => {
    assert.equal(validate({ type: "number" }, 3.14), 3.14);
    assert.equal(validate({ type: "number" }, 0), 0);
    assert.equal(validate({ type: "number" }, -5), -5);
  });

  it("rejects non-numbers and NaN", () => {
    assert.throws(() => validate({ type: "number" }, "3"), SchemaError);
    assert.throws(() => validate({ type: "number" }, NaN), SchemaError);
    assert.throws(() => validate({ type: "number" }, true), SchemaError);
  });
});

describe("validate — integers", () => {
  it("accepts integers", () => {
    assert.equal(validate({ type: "integer" }, 42), 42);
    assert.equal(validate({ type: "integer" }, -1), -1);
  });

  it("rejects non-integer numbers", () => {
    assert.throws(() => validate({ type: "integer" }, 1.5), SchemaError);
  });
});

describe("validate — booleans", () => {
  it("accepts booleans", () => {
    assert.equal(validate({ type: "boolean" }, true), true);
    assert.equal(validate({ type: "boolean" }, false), false);
  });

  it("rejects non-booleans", () => {
    assert.throws(() => validate({ type: "boolean" }, "true"), SchemaError);
    assert.throws(() => validate({ type: "boolean" }, 0), SchemaError);
  });
});

describe("validate — arrays", () => {
  const schema: JsonSchema = { type: "array", items: { type: "number" } };

  it("accepts arrays of valid items", () => {
    assert.deepEqual(validate(schema, [1, 2, 3]), [1, 2, 3]);
    assert.deepEqual(validate(schema, []), []);
  });

  it("rejects non-arrays", () => {
    assert.throws(() => validate(schema, "nope"), SchemaError);
    assert.throws(() => validate(schema, { 0: 1 }), SchemaError);
  });

  it("validates each item and reports its index in the path", () => {
    assert.throws(
      () => validate(schema, [1, "two", 3]),
      (err: unknown) => err instanceof SchemaError && err.path === "$[1]",
    );
  });
});

describe("validate — objects", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
  };

  it("accepts well-formed objects", () => {
    assert.deepEqual(validate(schema, { name: "Elf", age: 3 }), {
      name: "Elf",
      age: 3,
    });
  });

  it("treats every listed property as required", () => {
    assert.throws(
      () => validate(schema, { name: "Elf" }),
      (err: unknown) => err instanceof SchemaError && err.path === "$.age",
    );
  });

  it("treats an explicit undefined as missing", () => {
    assert.throws(
      () => validate(schema, { name: "Elf", age: undefined }),
      SchemaError,
    );
  });

  it("rejects non-objects, null, and arrays", () => {
    assert.throws(() => validate(schema, null), SchemaError);
    assert.throws(() => validate(schema, [], "$"), SchemaError);
    assert.throws(() => validate(schema, "obj"), SchemaError);
  });

  it("drops keys not declared in properties", () => {
    const out = validate(schema, { name: "Elf", age: 3, extra: true });
    assert.deepEqual(out, { name: "Elf", age: 3 });
  });

  it("reports nested paths", () => {
    const nested: JsonSchema = {
      type: "object",
      properties: {
        inner: { type: "object", properties: { n: { type: "number" } } },
      },
    };
    assert.throws(
      () => validate(nested, { inner: { n: "bad" } }),
      (err: unknown) => err instanceof SchemaError && err.path === "$.inner.n",
    );
  });
});

describe("validate — map", () => {
  const schema: JsonSchema = { type: "map", values: { type: "string" } };

  it("accepts an empty object", () => {
    assert.deepEqual(validate(schema, {}), {});
  });

  it("accepts an object with arbitrary string keys", () => {
    assert.deepEqual(validate(schema, { a: "x", b: "y" }), { a: "x", b: "y" });
  });

  it("preserves all keys (unlike object which drops undeclared keys)", () => {
    const out = validate(schema, { foo: "1", bar: "2", baz: "3" });
    assert.deepEqual(out, { foo: "1", bar: "2", baz: "3" });
  });

  it("rejects non-objects, null, and arrays", () => {
    assert.throws(() => validate(schema, null), SchemaError);
    assert.throws(() => validate(schema, "nope"), SchemaError);
    assert.throws(() => validate(schema, []), SchemaError);
  });

  it("validates each value and reports the key in the path", () => {
    assert.throws(
      () => validate(schema, { a: "ok", b: 42 }),
      (err: unknown) => err instanceof SchemaError && err.path === '$["b"]',
    );
  });

  it("works with non-string value schemas", () => {
    const numMap: JsonSchema = { type: "map", values: { type: "number" } };
    assert.deepEqual(validate(numMap, { x: 1, y: 2 }), { x: 1, y: 2 });
    assert.throws(() => validate(numMap, { x: "not-a-number" }), SchemaError);
  });
});

describe("validate — optional", () => {
  const schema: JsonSchema = { type: "optional", inner: { type: "string" } };

  it("accepts null", () => {
    assert.equal(validate(schema, null), null);
  });

  it("validates against the inner schema when not null", () => {
    assert.equal(validate(schema, "hi"), "hi");
    assert.throws(() => validate(schema, 5), SchemaError);
  });

  it("still requires the key to be present inside an object", () => {
    const obj: JsonSchema = {
      type: "object",
      properties: { maybe: { type: "optional", inner: { type: "string" } } },
    };
    // null is fine, but the key cannot be absent.
    assert.deepEqual(validate(obj, { maybe: null }), { maybe: null });
    assert.throws(() => validate(obj, {}), SchemaError);
  });
});

describe("validate — union", () => {
  const schema: JsonSchema = {
    type: "union",
    anyOf: [{ type: "string" }, { type: "number" }],
  };

  it("accepts a value matching any variant", () => {
    assert.equal(validate(schema, "hi"), "hi");
    assert.equal(validate(schema, 42), 42);
  });

  it("rejects a value matching no variant, listing why", () => {
    assert.throws(
      () => validate(schema, true),
      (err: unknown) =>
        err instanceof SchemaError &&
        err.path === "$" &&
        /no union variant matched/.test(err.message) &&
        /expected string/.test(err.message) &&
        /expected number/.test(err.message),
    );
  });

  it("returns the first matching variant's normalized value", () => {
    // The object arm drops undeclared keys; the first arm (string) can't match
    // an object, so the second arm runs and strips `extra`.
    const objOrStr: JsonSchema = {
      type: "union",
      anyOf: [
        { type: "string" },
        { type: "object", properties: { n: { type: "number" } } },
      ],
    };
    assert.deepEqual(validate(objOrStr, { n: 1, extra: true }), { n: 1 });
  });

  it("expresses a discriminated Result union", () => {
    // Result<string>: { ok: true, value } | { ok: false, error }. A literal on
    // `ok` discriminates the arms, so a mismatched-payload shape is rejected.
    const result = new Schema<
      { ok: true; value: string } | { ok: false; error: string }
    >({
      type: "union",
      anyOf: [
        {
          type: "object",
          properties: {
            ok: { type: "literal", value: true },
            value: { type: "string" },
          },
        },
        {
          type: "object",
          properties: {
            ok: { type: "literal", value: false },
            error: { type: "string" },
          },
        },
      ],
    });

    assert.deepEqual(result.parse({ ok: true, value: "yes" }), {
      ok: true,
      value: "yes",
    });
    assert.deepEqual(result.parse({ ok: false, error: "boom" }), {
      ok: false,
      error: "boom",
    });
    assert.equal(result.isValid({ ok: true }), false); // success arm needs value
    // Discriminator pins each arm: ok:false can't borrow the success payload.
    assert.equal(result.isValid({ ok: false, value: "x" }), false);
    assert.equal(result.isValid({ ok: true, error: "x" }), false);
  });
});

describe("validate — any", () => {
  it("accepts every JSON-compatible value and returns it unchanged", () => {
    assert.equal(validate({ type: "any" }, "hi"), "hi");
    assert.equal(validate({ type: "any" }, 42), 42);
    assert.equal(validate({ type: "any" }, true), true);
    assert.equal(validate({ type: "any" }, null), null);
    assert.deepEqual(validate({ type: "any" }, [1, 2]), [1, 2]);
    assert.deepEqual(validate({ type: "any" }, { x: 1 }), { x: 1 });
  });

  it("preserves a nested value inside an object property", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { data: { type: "any" } },
    };
    const val = { nested: [1, 2, 3], flag: true };
    assert.deepEqual(validate(schema, { data: val }), { data: val });
  });
});

describe("validate — literal", () => {
  it("matches a fixed value by strict equality", () => {
    assert.equal(validate({ type: "literal", value: "go" }, "go"), "go");
    assert.equal(validate({ type: "literal", value: 7 }, 7), 7);
    assert.equal(validate({ type: "literal", value: true }, true), true);
  });

  it("rejects anything else, including loose-equal values", () => {
    assert.throws(
      () => validate({ type: "literal", value: true }, 1),
      SchemaError,
    );
    assert.throws(
      () => validate({ type: "literal", value: "go" }, "GO"),
      SchemaError,
    );
  });
});

describe("SchemaError", () => {
  it("carries the path and formats the message", () => {
    const err = new SchemaError("$.foo", "expected string");
    assert.equal(err.path, "$.foo");
    assert.equal(err.message, "$.foo: expected string");
    assert.equal(err.name, "SchemaError");
    assert.ok(err instanceof Error);
  });

  it("defaults the root path to $", () => {
    assert.throws(
      () => validate({ type: "string" }, 1),
      (err: unknown) => err instanceof SchemaError && err.path === "$",
    );
  });
});

describe("Schema wrapper", () => {
  const schema = new Schema<{ name: string }>({
    type: "object",
    properties: { name: { type: "string" } },
  });

  it("parse returns the validated value", () => {
    assert.deepEqual(schema.parse({ name: "Elf" }), { name: "Elf" });
  });

  it("parse throws on invalid input", () => {
    assert.throws(() => schema.parse({}), SchemaError);
  });

  it("safeParse returns an ok result on success", () => {
    assert.deepEqual(schema.safeParse({ name: "Elf" }), {
      ok: true,
      value: { name: "Elf" },
    });
  });

  it("safeParse returns an error string on failure", () => {
    const result = schema.safeParse({});
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /required property missing/);
  });

  it("isValid reflects conformance", () => {
    assert.equal(schema.isValid({ name: "Elf" }), true);
    assert.equal(schema.isValid({ name: 1 }), false);
  });

  it("toJSON returns the underlying definition", () => {
    const def: JsonSchema = { type: "string" };
    assert.equal(new Schema(def).toJSON(), def);
  });
});
