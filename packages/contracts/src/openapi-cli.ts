import { buildOpenApiDocument } from "./openapi.js";

process.stdout.write(JSON.stringify(buildOpenApiDocument(), null, 2));
