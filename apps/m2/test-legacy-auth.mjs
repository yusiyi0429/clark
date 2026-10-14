import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateBindings,createLegacyAuth} from './legacy-auth.mjs';

test('Legacy identity is server-verified; client member IDs and unrelated cookies are ignored',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'m2-auth-'));
 try{
  const file=join(dir,'accounts.json');await writeFile(file,JSON.stringify({schemaVersion:1,bindings:[{personId:'verified-id',memberId:'member-02'}]}));
  const env={PUBLIC_ORIGIN:'https://trial.example',M2_ACCOUNT_MAP_FILE:file,M2_AUTH_API_URL:'http://api:4000/api/auth/session',M2_INTERNAL_TOKEN:'test-internal-token-32-characters-only'};
  let session={authenticated:true,personId:'verified-id',role:'member'},outage=false;
  const auth=await createLegacyAuth({env,transport:async(url,options)=>{assert.equal(url.href,env.M2_AUTH_API_URL);assert.deepEqual(options.headers,{cookie:'warmap_session=opaque'});assert.equal(options.redirect,'error');if(outage)throw Error('private outage');return {ok:true,json:async()=>session};}});
  const req={method:'GET',headers:{host:'trial.example',cookie:'other=secret; warmap_session=opaque','x-person-id':'admin'},socket:{remoteAddress:'10.0.0.2'}};
  assert.deepEqual(await auth(req,'/api/data'),{memberId:'member-02',homeHref:'/me'});
  await assert.rejects(auth({...req,headers:{...req.headers,'x-m2-expected-member':'member-01'}},'/api/actions'),{status:409,code:'IDENTITY_CHANGED'});
  session={authenticated:false};await assert.rejects(auth(req,'/api/data'),{status:401});
  session={authenticated:true,personId:'unknown',role:'ceo'};await assert.rejects(auth(req,'/api/data'),{status:403});
  outage=true;await assert.rejects(auth(req,'/api/data'),{status:503});
  await assert.rejects(auth({...req,headers:{host:'trial.example'}},'/api/data'),{status:401});
  await assert.rejects(auth({...req,method:'POST',headers:{...req.headers,origin:'https://evil.example'}},'/api/actions'),{status:403});
  await assert.rejects(auth({...req,headers:{...req.headers,host:'evil.example'}},'/api/data'),{status:403});
  assert.deepEqual(await auth({method:'POST',headers:{'x-m2-internal-token':env.M2_INTERNAL_TOKEN},socket:{remoteAddress:'127.0.0.1'}},'/api/nexus'),{internal:true});
  await assert.rejects(auth({method:'POST',headers:{'x-m2-internal-token':env.M2_INTERNAL_TOKEN},socket:{remoteAddress:'10.0.0.2'}},'/api/nexus'),{status:403});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Duplicate identity and member bindings are rejected; roster roles are never supplied by the browser',()=>{
 assert.throws(()=>validateBindings({schemaVersion:1,bindings:[{personId:'a',memberId:'member-02'},{personId:'b',memberId:'member-02'}]}));
 assert.throws(()=>validateBindings({schemaVersion:1,bindings:[{personId:'a',memberId:'unknown'}]}));
});
