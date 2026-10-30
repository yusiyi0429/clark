import {test} from 'node:test';import assert from 'node:assert/strict';
import {readM2Git,m2BuildInfo} from './build-info.mjs';import {m2VersionLabel,m2VersionDetails} from './build-version.mjs';
const commit='1234567890abcdef1234567890abcdef12345678',other='abcdef1234567890abcdef1234567890abcdef12',now=new Date('2026-10-30T08:00:00.000Z');
test('归档目录不借上级TKOS提交，M2文件不受该库跟踪时也回退未知',()=>{
 const calls=[];assert.equal(readM2Git('/tkos/output/archive/apps/m2',args=>{calls.push(args);return '/tkos';}),null);assert.equal(calls.length,1);
 assert.equal(readM2Git('/repo/apps/m2',args=>{if(args[0]==='ls-files')throw Error('未跟踪');return '/repo';}),null);
 const result=readM2Git('/repo/apps/m2',args=>{if(args[0]==='status'){assert.equal(args.at(-1),'.');return ' M app.jsx';}return args[0]==='ls-files'?'build.mjs':args.includes('--show-toplevel')?'/repo':commit;});assert.deepEqual(result,{commit,dirty:true});
});
test('源码构建取本库提交并标未提交修改；归档构建显式注入准确提交和环境',()=>{
 assert.deepEqual(m2BuildInfo({git:{commit,dirty:true},env:{},now}),{commit,builtAt:now.toISOString(),environment:'unknown',dirty:true});
 const archive=m2BuildInfo({git:null,env:{M2_BUILD_COMMIT:commit.toUpperCase(),M2_BUILD_ENV:'production'},now});assert.equal(archive.commit,commit);assert.equal(archive.environment,'production');assert.equal(archive.dirty,null);
 assert.equal(m2BuildInfo({git:null,env:{},now}).commit,null);assert.equal(m2BuildInfo({git:null,env:{M2_BUILD_ENV:'unverified'},now}).environment,'unknown');
 assert.throws(()=>m2BuildInfo({git:null,env:{M2_BUILD_COMMIT:'2.1.11'},now}),/完整 Git/);assert.throws(()=>m2BuildInfo({git:{commit,dirty:false},env:{M2_BUILD_COMMIT:other},now}),/不一致/);
});
test('角标区分M2前端产物、实际本地访问和未提供版本；悬浮信息保留完整来源',()=>{
 const info={commit,builtAt:now.toISOString(),environment:'production',dirty:false};assert.equal(m2VersionLabel(info,'tk.example.com'),'M2 · 1234567 · 生产');assert.equal(m2VersionLabel(info,'127.0.0.1'),'M2 · 1234567 · 本地');assert.equal(m2VersionLabel({...info,dirty:true},'localhost'),'M2 · 1234567* · 本地');
 assert.equal(m2VersionLabel({},'tk.example.com'),'M2 · 版本未提供 · 环境未知');assert.equal(m2VersionLabel({commit:'2c8b663'},'localhost'),'M2 · 版本未提供 · 本地');assert.match(m2VersionDetails(info),new RegExp(commit));assert.match(m2VersionDetails(info),/2026.*10.*30.*16:00:00.*北京时间/);
});
