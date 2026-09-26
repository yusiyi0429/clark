const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const load = name => JSON.parse(fs.readFileSync(path.join(__dirname,name),'utf8'));
const before=load('browser-before.json').result, final=load('browser-final.json').result, target=load('browser-targets.json');
assert(final && before); assert.equal(final.rounds[0].status,'confirmed'); assert.equal(final.rounds[0].window_seq,2);
for(const old of before.missions){const next=final.missions.find(m=>m.id===old.id);assert(next);
  if(old.id===target.missionId){assert.equal(next.version,2);assert.equal(next.outcome,'10 月 25 日前交付可复验的集成方案，并与交付负责人核对验收证据。');assert.deepEqual(next.milestones,['10 月 15 日 · 完成接口核对','10 月 25 日 · 联合验收']);for(const key of Object.keys(old).filter(k=>!['version','outcome','milestones'].includes(k)))assert.deepEqual(next[key],old[key]);}
  else assert.deepEqual(next,old);
}
assert.equal(final.reviews.length,2);assert.equal(final.reviews[0].note,null);assert.equal(final.reviews[1].applied_versions[target.missionId],2);
assert.equal(final.reviews[0].feedback_ids.length,4);assert.equal(final.reviews[1].feedback_ids.length,5);assert.equal(final.feedback.length,6);
const result={passed:true,changedMissions:1,unchangedMissions:11,updatedFields:['outcome','milestones'],missionVersion:2,roundVersion:final.rounds[0].version,reviews:2,snapshotCounts:[4,5],feedback:6,oldNote:null,appliedVersions:final.reviews[1].applied_versions};
fs.writeFileSync(path.join(__dirname,'browser-final-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
