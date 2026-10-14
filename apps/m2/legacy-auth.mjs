import {readFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {memberProfiles} from './member-profiles.mjs';

const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function validateBindings(value){
 if(value?.schemaVersion!==1||!Array.isArray(value.bindings)||!value.bindings.length)throw Error('M2 账号映射为空或格式无效');
 const map=new Map(),members=new Set();
 for(const b of value.bindings){
  if(typeof b.personId!=='string'||!b.personId.trim()||!memberProfiles[b.memberId]||map.has(b.personId)||members.has(b.memberId))throw Error('M2 账号映射重复或成员无效');
  map.set(b.personId,b.memberId);members.add(b.memberId);
 }
 return map;
}
export async function createLegacyAuth({env=process.env,transport=fetch}={}){
 const origin=new URL(env.PUBLIC_ORIGIN||'');
 if(origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw Error('PUBLIC_ORIGIN 必须为站点来源');
 const url=new URL(env.M2_AUTH_API_URL||'http://api:4000/api/auth/session');
 if(url.username||url.password||url.pathname!=='/api/auth/session'||url.search||url.hash||!['http:','https:'].includes(url.protocol))throw Error('M2 登录校验地址无效');
 const bindings=validateBindings(JSON.parse(await readFile(env.M2_ACCOUNT_MAP_FILE,'utf8')));
 if(!env.M2_INTERNAL_TOKEN||env.M2_INTERNAL_TOKEN.length<32)throw Error('M2_INTERNAL_TOKEN 至少需要 32 个字符');
 return async function authenticate(req,path){
  if(req.method==='POST'&&path==='/api/nexus'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&equal(req.headers['x-m2-internal-token'],env.M2_INTERNAL_TOKEN))return {internal:true};
  if(req.headers.host!==origin.host)fail(403,'站点不允许');
  if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin.origin)fail(403,'来源不允许');
  const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('warmap_session='));
  if(!cookie)fail(401,'请先登录天枢');
  let response;
  try{response=await transport(url,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{cookie}});}catch{fail(503,'天枢登录校验暂不可用，请稍后重试');}
  if(!response.ok)fail(503,'天枢登录校验暂不可用，请稍后重试');
  let session;try{session=await response.json();}catch{fail(503,'天枢登录校验返回无效，请稍后重试');}
  if(session.authenticated!==true||typeof session.personId!=='string')fail(401,'登录已失效，请重新登录天枢');
  const memberId=bindings.get(session.personId);if(!memberId)fail(403,'当前账号尚未加入 M2 试用名单');
  return {memberId,homeHref:session.role==='ceo'?'/':'/me'};
 };
}
