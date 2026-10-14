// Retained only for callers of the retired API. Never invoke a model here.
export async function formatReaderViews(){
 throw Object.assign(Error('二次摘要已取消。请直接展示技能输出，并在技能中调整表达。'),{code:'READER_REWRITE_DISABLED'});
}
