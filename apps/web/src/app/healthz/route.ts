/** Web 自身健康检查：不请求 API、数据库、模型或 Provider。 */
export async function GET() {
  return Response.json({ status: "ok", buildSha: process.env.BUILD_SHA ?? "dev" });
}
