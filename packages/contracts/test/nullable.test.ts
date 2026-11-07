import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { NullableInteger, NullableNumber } from "../src/nullable.js";

describe("可以为空的数字", () => {
  it("JSON Schema 是类型数组；Value.Check 认 null、0 和范围，整数不收小数", () => {
    const schema = Type.Object({ percent: NullableInteger({ minimum: 0, maximum: 100 }), hours: NullableNumber({ exclusiveMinimum: 0 }) });
    expect(JSON.parse(JSON.stringify(schema.properties.percent))).toEqual({ type: ["integer", "null"], minimum: 0, maximum: 100 });
    expect(Value.Check(schema, { percent: null, hours: null })).toBe(true);
    expect(Value.Check(schema, { percent: 0, hours: 0.5 })).toBe(true);
    expect([Value.Check(schema, { percent: 101, hours: 1 }), Value.Check(schema, { percent: 1.5, hours: 1 }), Value.Check(schema, { percent: 1, hours: 0 }),
      Value.Check(schema, { percent: "7", hours: 1 })]).toEqual([false, false, false, false]);
  });
});
