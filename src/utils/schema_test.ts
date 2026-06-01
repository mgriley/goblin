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
