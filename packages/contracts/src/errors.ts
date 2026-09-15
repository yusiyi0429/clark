import { Type, type Static } from "@sinclair/typebox";
import { Card } from "./cards.js";

export const ApiError = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    retryable: Type.Boolean(),
    requestId: Type.String(),
    fieldErrors: Type.Optional(Type.Record(Type.String(), Type.String())),
    latestCard: Type.Optional(Card),
  },
  { additionalProperties: false, $id: "ApiError" },
);

export type TApiError = Static<typeof ApiError>;
