/**
 * 服务起来那一刻跑一次的事情（Next 的 `instrumentation` 约定：`register()` 每个服务实例
 * 只被叫一次，而且要跑完服务才开始接请求）。
 *
 * 这里原来还有一件：本机把实验台（一台 python 服务）带起来。扫描搬回这个仓库自己跑之后
 * （`lib/scan/run.ts`），那台服务不再是任何一条链路的前提，带起它的代码也就一起删了。
 *
 * 现在有一件：**接上重启前没跑完的录音**。
 */
export async function register(): Promise<void> {
  /*
   * 这个文件在 edge runtime 下也会被求值一次，而录音流水线是纯 node（child_process、
   * 文件系统）。不挡这一道的话，edge 那次求值会在 import 阶段就炸，而炸出来的错和录音
   * 一个字关系都没有。
   */
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  /*
   * 动态 import，**不写在文件顶上**：静态 import 会把整条流水线（连带对象库和 TOS
   * SDK）拖进每一个 runtime 的 bundle，包括上面那一道 return 掉的。
   *
   * 起服务时扫一遍就够了 —— 之后由流水线自己的圈接管，而那个圈没活时会把自己停掉。
   * 所以这只是四个 `kick()` 调用点里的一个（另外三个是上传、重试、结束录音那三条
   * 路由），完整那张表在 `pipeline.ts` 文件头。
   */
  const { kick } = await import("@/lib/recording/pipeline");
  kick();
}