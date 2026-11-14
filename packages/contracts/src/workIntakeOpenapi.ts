import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import { CreateWorkIntake, PartnerWorkEvents, WorkIntakeChange, WorkIntakeEntry, WorkIntakeList, WorkIntakeScope } from "./workIntake.js";
export const workIntakeSchemas: Record<string,JsonSchema> = { CreateWorkIntake, WorkIntakeChange, WorkIntakeEntry, WorkIntakeList,PartnerWorkEvents };
const content = (name: string) => ({ "application/json": { schema: { $ref: "#/components/schemas/" + name } } });
const ok = (name: string) => ({200: {description: "已读取",content: content(name)}});
export const workIntakePaths: OpenAPIV3.Document["paths"] = {
  "/api/me/partner-work-events": {get:{operationId:"listPartnerWorkEvents",responses:ok("PartnerWorkEvents")}},
  "/api/me/work-intake": {
    get: {operationId: "listWorkIntake", parameters: [{name:"scope",in:"query",required:true,schema:WorkIntakeScope}],responses:ok("WorkIntakeList")},
    post: {operationId:"createWorkIntake",requestBody:{required:true,content:content("CreateWorkIntake")},responses:ok("WorkIntakeEntry")},
  },
  "/api/me/work-intake/{id}": {patch:{operationId:"changeWorkIntake", parameters:[{name:"id",in:"path",required:true,schema:{type:"string",format:"uuid"}}],
    requestBody:{required:true,content:content("WorkIntakeChange")},responses:ok("WorkIntakeEntry")}},
};
