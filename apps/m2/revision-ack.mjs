import {createHash,randomUUID} from 'node:crypto';
import {currentVersion} from './governance.mjs';
const fingerprint=value=>{const {ackToken,reconfirmVersion,auto,...request}=value;return createHash('sha256').update(JSON.stringify(request)).digest('hex');};
// An acknowledgement is bound to the exact authenticated request and the version that was displayed.
export function createRevisionAcknowledgements(){
 const tokens=new Map();
 return {run(state,actor,request,operation){
  const {ackToken,reconfirmVersion,auto,...clean}=request,key=fingerprint(request),saved=tokens.get(ackToken);
  if(ackToken){
   if(!saved||saved.actorId!==actor.id||saved.key!==key||saved.expires<Date.now()||state.round?.id!==saved.roundId||state.reviewRound?.loadedAt!==saved.reviewLoadedAt||!state.cards[saved.cardId]||currentVersion(state.cards[saved.cardId]).number!==saved.version)throw Object.assign(Error('内容已变化，请重新检查后修改'),{status:409});
   const result=operation({...clean,reconfirmVersion:saved.version});tokens.delete(ackToken);return result;
  }
  try{return operation(clean);}catch(error){
   if(error.code!=='RECONFIRM_REQUIRED')throw error;
   for(const [token,value]of tokens)if(value.expires<Date.now())tokens.delete(token);
   if(tokens.size>=200)tokens.delete(tokens.keys().next().value);
   const token=randomUUID();tokens.set(token,{actorId:actor.id,key,cardId:error.cardId,version:error.version,roundId:state.round?.id,reviewLoadedAt:state.reviewRound?.loadedAt,expires:Date.now()+10*60000});error.reconfirmToken=token;throw error;
  }
 }};
}
