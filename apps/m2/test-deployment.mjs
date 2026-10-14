import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalize} from './domain.mjs';
import {createCollaborationState} from './governance.mjs';

const dir=await mkdtemp(join(tmpdir(),'m2-deployment-'));
const keys=['bf01','bf02','bf03','rearch','method','agents','eo','tokenhub','talent','finance'];
const raw=keys.map((key,i)=>({key,name:key,owner:i===0?'刘明华':'刘人豪',title:`synthetic ${key}`,result:'测试成果',checks:['测试验收'],missions:[{title:'测试 Mission',owner:i===0?'白田田':'孙铭泽',result:'测试结果',checks:['通过'],tasks:[{title:'测试 Task',owner:i===0?'白田田':'孙铭泽',result:'测试交付',checks:['通过']}]}]}));
const units=normalize(raw),state=createCollaborationState(units);
state.round={id:'test-round',number:1,units,input:{mode:'synthetic-test',sources:[],retrievedAt:'2026-10-14T00:00:00Z'}};
await writeFile(join(dir,'bootstrap.json'),JSON.stringify({schemaVersion:1,state}));
await writeFile(join(dir,'source-manifest.json'),JSON.stringify({version:1,period:'2026-10',cutoff:'2026-10-09T23:59:59+08:00',selections:[],pending:[]}));
await writeFile(join(dir,'accounts.json'),JSON.stringify({schemaVersion:1,bindings:[{personId:'ceo',memberId:'member-01'},{personId:'owner',memberId:'member-02'},{personId:'other',memberId:'member-03'}]}));
const legacy=createServer((req,res)=>{const id=req.headers.cookie?.replace('warmap_session=','');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authenticated:!!id&&id!=='revoked',personId:id,role:id==='ceo'?'ceo':'member'}));});
await new Promise(r=>legacy.listen(0,'127.0.0.1',r));
Object.assign(process.env,{NODE_ENV:'test',PUBLIC_ORIGIN:'http://trial.example',M2_AUTH_API_URL:`http://127.0.0.1:${legacy.address().port}/api/auth/session`,M2_ACCOUNT_MAP_FILE:join(dir,'accounts.json'),M2_SEED_DIR:dir,M2_INTERNAL_TOKEN:'test-internal-token-at-least-32-characters',DECODING_STATE_PATH:join(dir,'collaboration.json'),DECODING_DISABLE_LOCAL_KEY:'1'});
delete process.env.DECODING_API_KEY;delete process.env.TOKENHUB_API_KEY;delete process.env.TKOS_WORLD_PRODUCT_TOKEN;delete process.env.DECODING_API_KEY_FILE;
const {server}=await import('./server.mjs');await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
// Node fetch ignores a custom Host; use a real proxy-style HTTP request here.
const call=(path,id,body)=>new Promise((resolve,reject)=>{
 const req=request(base+'/m2'+path,{method:body?'POST':'GET',headers:{host:'trial.example',...(id?{cookie:'warmap_session='+id}:{}),...(body?{origin:'http://trial.example','Content-Type':'application/json'}:{})}},res=>{
  const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
 });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
});
after(async()=>{await new Promise(r=>server.close(r));await new Promise(r=>legacy.close(r));await rm(dir,{recursive:true,force:true});});

test('Every M2 page/API needs the legacy session; revoked and unmapped accounts are rejected',async()=>{
 const root=await call('/');assert.equal(root.status,302);assert.equal(root.headers.get('location'),'/access');
 for(const path of ['/api/session','/api/data','/api/collaboration?member=member-01','/api/rounds','/api/ontology/status','/app.js'])assert.equal((await call(path)).status,401,path);
 assert.equal((await call('/api/data','revoked')).status,401);
 assert.equal((await call('/api/data','unmapped')).status,403);
});
test('Authenticated identity overrides spoofed query/body IDs and filters plan payloads',async()=>{
 const data=await (await call('/api/data','owner')).json();assert.equal(data.session.memberId,'member-02');assert.deepEqual(data.units.map(u=>u.id),['bf01','method']);
 const shared=await(await call('/api/collaboration?member=member-01','owner')).json();assert.equal(shared.memberId,'member-02');assert.deepEqual(shared.round.units.map(u=>u.id),['bf01','method']);
 assert.equal((await call('/api/rounds','owner',{memberId:'member-01',sourceMode:'ontology'})).status,403);
 assert.equal((await call('/api/actions','owner',{memberId:'member-01',action:{type:'confirm',cardId:'bf01',baseVersion:1,slot:'ceo'}})).status,403);
 assert.equal((await call('/api/actions','owner',{memberId:'member-03',action:{type:'revise',cardId:'bf01-m1',baseVersion:1,patch:{result:'修订后'}}})).status,200);
});
test('Real HTTP flow preserves private chat isolation and same-version confirmation without legacy plan writes',async()=>{
 const act=(id,action)=>call('/api/actions',id,{memberId:'member-01',action});
 assert.equal((await act('owner',{type:'privateMessage',text:'只有本人可见'})).status,200);
 assert.equal((await act('owner',{type:'message',cardId:'bf01',text:'公开意见'})).status,200);
 const ceo=await(await call('/api/collaboration?member=member-02','ceo')).json();assert.equal(ceo.records['private:member-02'],undefined);assert.equal(ceo.records['group:bf01'].at(-1).text,'公开意见');
 assert.equal((await act('owner',{type:'confirm',cardId:'bf01-m1',baseVersion:2,slot:'missionDri'})).status,200);
 assert.equal((await act('ceo',{type:'confirm',cardId:'bf01-m1',baseVersion:2,slot:'unitDri'})).status,200);
 const confirmed=await(await call('/api/collaboration','owner')).json();assert.equal(confirmed.drafts['bf01-m1'].status,'已确认');
 const stored=JSON.parse(await readFile(join(dir,'collaboration.json'),'utf8'));assert.equal(stored.round.id,'test-round');assert.equal(stored.cards['bf01-m1'].versions.length,2);
});
