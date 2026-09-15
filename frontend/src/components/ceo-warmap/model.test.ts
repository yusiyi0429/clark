import {describe,it,expect} from 'vitest';
import {resolveCommand} from './model';
describe('CEO global navigation intents',()=>{
 it('locates a zone research section instead of starting an unrelated report',()=>expect(resolveCommand('看看灯塔项目目前在研究什么议题')).toEqual({kind:'view',view:'lighthouse',section:'issues'}));
 it('keeps a named payment question attached to its canonical issue',()=>expect(resolveCommand('研究一下灯塔是否必须验证客户付费')).toEqual({kind:'issue',issue:'payment',research:true}));
 it('uses the current issue for a follow-up evidence request',()=>expect(resolveCommand('这个议题的依据是什么','lighthouse','payment')).toEqual({kind:'issue',issue:'payment',research:true}));
 it('uses current zone for a goal request',()=>expect(resolveCommand('看看本月目标','lighthouse')).toEqual({kind:'view',view:'lighthouse',section:'goals'}));
 it('does not turn negation into navigation or execute organizational directions',()=>{expect(resolveCommand('不要打开灯塔项目')).toEqual({kind:'unknown'});expect(resolveCommand('先停掉灯塔战役')).toEqual({kind:'unknown'});expect(resolveCommand('给灯塔增加预算')).toEqual({kind:'unknown'});});
 it('resolves output mute independently from stopping the microphone',()=>{expect(resolveCommand('静音')).toEqual({kind:'mute',muted:true});expect(resolveCommand('恢复声音')).toEqual({kind:'mute',muted:false});});
 it('sends reasoning and challenges to the model instead of reopening keyword-matched cards',()=>{expect(resolveCommand('为什么客户愿意付费','lighthouse','payment')).toEqual({kind:'unknown'});expect(resolveCommand('我不认同灯塔现在的判断','lighthouse','payment')).toEqual({kind:'unknown'});expect(resolveCommand('如果灯塔失败，应该怎么调整公司战略')).toEqual({kind:'unknown'});});
});
