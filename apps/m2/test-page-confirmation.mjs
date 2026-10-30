import {test} from 'node:test';
import assert from 'node:assert/strict';
import {confirmInPage,getPageConfirmation,subscribePageConfirmation,cancelPageConfirmation} from './page-confirmation.mjs';
test('每次确认独立：并发意图取消，旧选择不能决定新请求，重复选择无效',async()=>{
 const stop=subscribePageConfirmation(()=>{});
 try{
  const first=confirmInPage('第一处'),old=getPageConfirmation();
  assert.equal(await confirmInPage('另一处'),false);assert.equal(getPageConfirmation(),old);
  old.choose(true);old.choose(false);assert.equal(await first,true);
  const second=confirmInPage('第二处'),next=getPageConfirmation();old.choose(true);assert.equal(getPageConfirmation(),next);
  next.choose(false);assert.equal(await second,false);assert.equal(getPageConfirmation(),null);
 }finally{stop();}
});
test('取消、请求中止和宿主卸载均结束等待；无宿主时保守取消',async()=>{
 assert.equal(await confirmInPage('没有页面'),false);
 const stop=subscribePageConfirmation(()=>{}),controller=new AbortController();
 const first=confirmInPage('请求中止',{signal:controller.signal});controller.abort();assert.equal(await first,false);
 assert.equal(await confirmInPage('已中止',{signal:controller.signal}),false);
 const second=confirmInPage('离开页面');stop();assert.equal(await second,false);
 const stopAgain=subscribePageConfirmation(()=>{});const third=confirmInPage('轮次切换');cancelPageConfirmation();assert.equal(await third,false);stopAgain();
});
