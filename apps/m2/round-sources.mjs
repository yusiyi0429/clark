import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const run=promisify(execFile);
// Foundation pages only. No round result, CEO example, feedback or ontology page.
export const sourceManifest=[
 ['company','Company 词元云集','E9DywZNqtidsBzkrcg6cRAAUn2e'],
 ['bf01','Battlefield 灯塔项目','ZAJAwbXMtiAY7gkmQAkcdWJEnWc'],
 ['bf02','Battlefield Token Ops','JhRAwWVQri5WrDkEtrgcgmIfnAb'],
 ['bf03','Battlefield 维信诺（002客户）','PQnVwxEdEivpllkJBEycirHInNd'],
 ['rearch','Domain Re-architecture','LfaJwGnG6inkI9kR7BicEfHdnZZ'],
 ['method','Domain Method','MqIawpvDdiqdzokzSoDcxf9tnFd'],
 ['agents','Domain Agents','KZIhwKT2Sim845k5yyXc7fhgnue'],
 ['agents','子域 CoAgent','Bbw0w4oT5iJ9cekdBA0cUk8Nn7S'],
 ['agents','子域 CEO&DRI Agent','M5nKwqVF5iAuXXkmko7cMNiIn1b'],
 ['eo','Domain E&O','MFOCw5nmkiVGFzks1nTcCZe5n7b'],
 ['eo','子域 Ontology','N0GIws6HpiD6B3kPJV0ciTlSneb'],
 ['tokenhub','Domain TokenHub','L7AAwbTGHiUSarkjKvXcr2Knn2b'],
 ['talent','Domain Talent & Organization','OqTnwbZAkiAzhTkvrumcHoLbnXe'],
 ['finance','Domain Finance, Compliance & Operations','M8YOwpJBtikTn7ksjCXcxVFHnbZ'],
 ['organization','组织结构与责任分工','UZB8wP5jQi7QcykuvimcLiZbnye'],
];
const headings=new Set(['9月复盘','最新现状','长期目标','资源、重点与验收要求','基本信息']);
export function foundationContent(xml,key){
 if(key==='organization')return xml;
 const sections=[...xml.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>([\s\S]*?)(?=<h1\b|$)/g)];
 const selected=sections.filter(s=>headings.has(s[1].replace(/<[^>]+>/g,'').trim()));
 if(!selected.length)throw Error('基础资料结构已改变，需要核对后才能拆解');
 return selected.map(s=>s[0]).join('\n');
}
export async function fetchRoundSources({fetchDocument,onProgress=()=>{}}={}){
 const fetcher=fetchDocument||(async token=>{const {stdout}=await run('lark-cli',['docs','+fetch','--doc',token,'--as','user'],{maxBuffer:12*1024*1024,timeout:60000});const value=JSON.parse(stdout);if(!value.ok)throw Error('飞书读取失败');return value.data.document;});
 const sources=[];
 // Small parallel batches avoid overloading the signed-in Feishu CLI.
 for(let i=0;i<sourceManifest.length;i+=3){await Promise.all(sourceManifest.slice(i,i+3).map(async([key,title,token])=>{const document=await fetcher(token);const content=foundationContent(document.content,key);sources.push({key,title,token,documentId:document.document_id,revision:document.revision_id,content,hash:createHash('sha256').update(content).digest('hex')});}));await onProgress(sources.length,sourceManifest.length);}
 return {mode:'independent-foundation-only',retrievedAt:new Date().toISOString(),sources:sources.sort((a,b)=>sourceManifest.findIndex(x=>x[2]===a.token)-sourceManifest.findIndex(x=>x[2]===b.token)),capacity:{hoursPerWorkday:null,otherWorkHours:null,workCalendar:null,externalWindows:null}};
}
