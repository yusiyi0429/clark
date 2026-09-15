export type JsonSchema = Record<string, unknown>;

export namespace OpenAPIV3 {
  export type OperationObject = {
    operationId: string;
    summary?: string;
    tags?: string[];
    requestBody?: unknown;
    responses: Record<string, unknown>;
  };
  export type ResponseObject = {
    description: string;
    content?: Record<string, { schema: JsonSchema }>;
  };
  export type PathItem = Partial<OperationObject>;
  export type Document = {
    openapi: string;
    info: { title: string; version: string; description?: string };
    servers?: { url: string }[];
    paths: Record<string, Record<string, PathItem>>;
    components: { schemas: Record<string, JsonSchema> };
  };
}
