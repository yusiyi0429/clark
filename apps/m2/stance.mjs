// Stance in one chat line, shared by the server rules and Nexus validation.
// Keyword checks alone misread "我不反对" or "大家有不同意见吗" as objections; strip negations and questions first.
const NEGATED=/(不反对|没有反对|并不反对|不是反对|没有不同意|不是不同意|没有异议|无异议|没意见|没有意见)/g;
const DISAGREE=/(不同意|不赞同|不认可|反对|不能接受|不接受|尚有分歧|有分歧)/;
const AGREE=/(同意|赞同|认可|(?<!不能|不|无法)接受|按这个|就这么改|就这样|没问题|可以这样|不反对|没有反对|没有异议|无异议)/;
const sentences=text=>String(text||'').split(/(?<=[。！!？?；;\n])/).map(s=>s.trim()).filter(Boolean);
const question=s=>/[吗？?]\s*$|有没有|是否|要不要/.test(s);
export function disagrees(text){return sentences(text).some(s=>!question(s)&&DISAGREE.test(s.replace(NEGATED,'')));}
// A bare 「好的」「行」「可以」 in reply to a concrete proposal is agreement too (2026-10-19 drill).
const BARE=/^(好的?|好吧|行|行吧|可以|嗯嗯?|OK|ok|没问题|同意)[。！!，,~～]*$/;
export function agrees(text){const t=String(text||'').trim();return BARE.test(t)||sentences(text).some(s=>!question(s)&&AGREE.test(s.replace(/(不同意|不赞同|不认可)/g,'')));}
// "这里不需要改" or "要不要改一下？" is not a request to change the card.
export function declinesChange(text){return /(不需要|不用|无需|不必|没必要)(再)?(改|修改|调整|动)/.test(String(text||''))||sentences(text).every(question);}
