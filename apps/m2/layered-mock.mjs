// Test double for the layered round: answers each stage from a fixed per-domain unit.
// Never calls a real model.
export const roundKeys=['bf01','bf02','bf03','rearch','method','agents','eo','tokenhub','talent','finance'];
const strip=(m,keys)=>Object.fromEntries(Object.entries(m).filter(([k])=>!keys.includes(k)));
export function layeredAnswer(q,makeUnit){
 const [layer,mode]=q.stage.split('-');
 if(mode==='check')return {issues:[],gaps:[],summary:'待核对'};
 if(mode==='generate'){
  const unit=makeUnit(q.key);
  if(layer==='po')return {po:strip(unit,['missions']),upstream:[],sharedEvents:[],gaps:[]};
  if(layer==='mission')return {missions:unit.missions.map(m=>strip(m,['tasks'])),gaps:[]};
  // Task layer: one Mission per call.
  const i=Math.max(0,unit.missions.findIndex(m=>m.title===q.mission.title));
  return {time:unit.missions[i]?.time??q.mission.time,tasks:structuredClone(unit.missions[i]?.tasks||unit.missions[0].tasks),gaps:[]};
 }
 // revise: hand back the current content unchanged unless a test overrides it
 if(layer==='po')return {po:q.current.po,upstream:q.current.upstream,sharedEvents:q.current.sharedEvents||[],gaps:[]};
 return {changes:[],gaps:[]};
}
export function layeredGateway(makeUnit,{onCall=()=>{},override=()=>undefined,...rest}={}){
 return {...rest,complete:async messages=>{
  const q=JSON.parse(messages[1].content);onCall(q,messages);
  const answer=override(q)??layeredAnswer(q,makeUnit);
  return {answer:JSON.stringify(answer),model:'isolated-test'};
 }};
}
