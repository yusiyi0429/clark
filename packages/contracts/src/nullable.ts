import { Kind, Type, TypeRegistry, type TUnsafe } from "@sinclair/typebox";

/**
 * 可以为空的数字：写成 JSON Schema 的类型数组 type: ["integer", "null"]（或 ["number", "null"]），不用 anyOf。
 * 原因：Fastify 的 Ajv 开着类型转换，anyOf [integer, null] 会把 null 转成 0，[null, integer] 会把 0 转成 null；类型数组两样都原样保留，"7" 照旧转成 7。
 * OpenAPI 3.1 认类型数组，生成的客户端类型仍是 number | null。
 * TypeBox 的 Value.Check 不认这种写法，这里注册成自定义类型（NullableNumber），按同样的规则校验。
 */

type Limits = { minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; description?: string };
const KIND = "NullableNumber";

if (!TypeRegistry.Has(KIND)) TypeRegistry.Set<Limits & { type: string[] }>(KIND, (schema, value) => value === null || (typeof value === "number" && Number.isFinite(value)
  && (!schema.type.includes("integer") || Number.isInteger(value))
  && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum)
  && (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum) && (schema.exclusiveMaximum === undefined || value < schema.exclusiveMaximum)));

/** 可以为空的整数。 */
export const NullableInteger = (limits: Limits = {}): TUnsafe<number | null> => Type.Unsafe<number | null>({ ...limits, [Kind]: KIND, type: ["integer", "null"] });
/** 可以为空的数（可以有小数）。 */
export const NullableNumber = (limits: Limits = {}): TUnsafe<number | null> => Type.Unsafe<number | null>({ ...limits, [Kind]: KIND, type: ["number", "null"] });
