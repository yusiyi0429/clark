import {createCollaborationState} from './governance.mjs';
import {carryReviewLayer} from './review-round.mjs';
export function activateIndependentRound(old,round){
 const next=createCollaborationState(round.units);
 next.archives=[...(old.archives||[]),{...old,round:old.round||{number:6,id:'legacy-round06'},archives:undefined}];
 next.round={id:round.id,number:round.number,units:round.units,input:round.input,audit:round.audit};
 next.sequence=old.sequence+1;
 return carryReviewLayer(old,next);
}
