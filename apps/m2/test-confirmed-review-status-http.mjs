import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createCollaborationState} from './governance.mjs';import {installReviewRound} from './review-round.mjs';
const id='rv:method-m1',po='rv:method';
function seed(status='未达成'){return installReviewRound(createCollaborationState([{id:'method',level:'po',title:'单元',owner:'白田田',result:'原成果',children:[{id:'method-m1',unit:'method',level:'mission',title:'首用',owner:'孙铭泽',result:'成果',children:[]}]}]),{period:'2026-10',reviews:[{ref:'company',unit:'company',level:'company',title:'公司',owner:'刘明华',verdict:'未达成',verdictReason:'公司原',facts:[],nextInputs:[]},{ref:'method',unit:'method',level:'ru',parent:'company',title:'单元',owner:'白田田',verdict:'未达成',verdictReason:'单元原',facts:[{ref:'method-m1',item:'首用',owner:'孙铭泽',status,evidence:'单元原证据',gap:'原缺口'},{ref:'other',item:'另一项',status:'达成',evidence:'保留',gap:''}],nextInputs:[]},{ref:'method-m1',unit:'method',level:'mission',parent:'method',title:'首用',owner:'孙铭泽',verdict:'未达成',verdictReason:'原理由',facts:[{ref:'t1',item:'任务',status:'未达成',evidence:'个人原记录',gap:'缺口'}],nextInputs:[]}]});}

const dir=await mkdtemp(join(tmpdir(),'m2-confirmed-http-')),state=seed();
state.round={id:'confirmed-http',number:1,units:[{id:'method',level:'po',children:[]}],input:{sources:[]}};
await writeFile(join(dir,'bootstrap.json'),JSON.stringify({schemaVersion:1,state}));await writeFile(join(dir,'accounts.json'),JSON.stringify({schemaVersion:1,bindings:[{personId:'owner',memberId:'member-03'},{personId:'dri',memberId:'member-02'},{personId:'ceo',memberId:'member-01'}]}));
const auth=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authenticated:true,personId:req.headers.cookie?.replace('warmap_session=',''),role:'member'}));});await new Promise(r=>auth.listen(0,'127.0.0.1',r));
Object.assign(process.env,{NODE_ENV:'test',LANGSMITH_TRACING:'false',DECODING_DISABLE_LOCAL_KEY:'1',PUBLIC_ORIGIN:'http://trial.example',M2_AUTH_API_URL:`http://127.0.0.1:${auth.address().port}/api/auth/session`,M2_ACCOUNT_MAP_FILE:join(dir,'accounts.json'),M2_INTERNAL_TOKEN:'synthetic-internal-token-at-least-32-characters',M2_SEED_DIR:dir,DECODING_STATE_PATH:join(dir,'state.json')});delete process.env.DECODING_API_KEY;delete process.env.TOKENHUB_API_KEY;delete process.env.DECODING_API_KEY_FILE;delete process.env.TKOS_WORLD_PRODUCT_TOKEN;
const {server}=await import('./server.mjs');await new Promise(r=>server.listen(0,'127.0.0.1',r));
const call=(who,path,body)=>new Promise((resolve,reject)=>{const req=request(`http://127.0.0.1:${server.address().port}/m2${path}`,{method:body?'POST':'GET',headers:{host:'trial.example',cookie:'warmap_session='+who,...(body?{origin:'http://trial.example','Content-Type':'application/json'}:{})}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
const action=(who,a,ackToken)=>call(who,'/api/actions',{action:a,...(ackToken?{ackToken}:{})});const saved=async()=>JSON.parse(await readFile(join(dir,'state.json'),'utf8'));
after(async()=>{await new Promise(r=>server.close(r));await new Promise(r=>auth.close(r));await rm(dir,{recursive:true,force:true});});
test('真实HTTP：无模型也在确认事务出单行卡，PO DRI接受；修改已签PO继续/取消不绕过',async()=>{
 assert.equal((await action('owner',{type:'insight',cardId:id,text:'洞察'})).status,200);
 assert.equal((await action('owner',{type:'revise',cardId:id,baseVersion:1,patch:{verdict:'达成'}})).status,200);
 assert.equal(((await saved()).proposals||[]).filter(p=>p.confirmedMission).length,0);
 assert.equal((await action('owner',{type:'confirm',cardId:id,baseVersion:2,slot:'missionDri'})).status,200);
 let s=await saved(),p=s.proposals.find(p=>p.confirmedMission);assert.ok(p);assert.equal(p.status,'pending');assert.equal(p.fromMission.version,2);assert.equal(s.cards[po].versions.length,1);
 assert.equal((await action('ceo',{type:'acceptProposal',cardId:po,proposalId:p.id})).status,403);
 assert.equal((await action('dri',{type:'acceptProposal',cardId:po,proposalId:p.id})).status,200);
 assert.equal((await action('ceo',{type:'insight',cardId:po,text:'洞察'})).status,200);
 assert.equal((await action('ceo',{type:'confirm',cardId:po,baseVersion:2,slot:'ceo'})).status,200);
 const revise={type:'revise',cardId:id,baseVersion:2,patch:{verdict:'部分达成'}},ask=await action('owner',revise);assert.equal(ask.status,409);assert.equal((await action('owner',revise,ask.data.reconfirmToken)).status,200);
 assert.equal((await action('owner',{type:'confirm',cardId:id,baseVersion:3,slot:'missionDri'})).status,200);
 s=await saved();p=s.proposals.find(p=>p.confirmedMission&&p.status==='pending');assert.ok(p);const accept={type:'acceptProposal',cardId:po,proposalId:p.id},before=await readFile(join(dir,'state.json'),'utf8'),challenge=await action('dri',accept);assert.equal(challenge.status,409);assert.equal(challenge.data.code,'RECONFIRM_REQUIRED');assert.equal(await readFile(join(dir,'state.json'),'utf8'),before,'取消即不重发，原state字节不动');assert.equal((await action('ceo',accept,challenge.data.reconfirmToken)).status,409);assert.equal((await action('dri',accept,challenge.data.reconfirmToken)).status,200);
 s=await saved();assert.equal(s.cards[po].versions.at(-1).content.facts[0].status,'部分达成');assert.equal(s.cards[po].versions.at(-1).content.verdict,'未达成');assert.equal(s.cards[po].versions.at(-1).signatures.length,0);assert.equal(s.cards[po].versions.at(-2).signatures.length,1);
});
