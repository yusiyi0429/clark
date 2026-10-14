export function mentionAt(text,caret){
 const before=text.slice(0,caret),match=before.match(/(?:^|[\s\u4e00-\u9fff，。？！、（(：:,])([@＠])([^\s@＠]*)$/u);
 return match?{start:caret-match[2].length-1,end:caret,query:match[2]}:null;
}
export function insertMention(text,mention,name){
 const value=text.slice(0,mention.start)+'@'+name+' '+text.slice(mention.end);
 return {value,caret:mention.start+name.length+2};
}
