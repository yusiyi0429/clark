# 02 · World 只读适配与 Company 阅读投影

Type: implementation
Status: needs-info
Blocked by: 当前真实实例的读取契约、覆盖与授权核对（离线部分可先实现）

## 工作

- 对照 memory-design.md §2–4，补齐完整 World 对象 schema 与只读 facade；保留产品 WorldClient.write，不能暴露给主 Agent。
- 用现有 fixture 及经联调确认的新响应测试 blocks、identity、relations、records、分页和外部关联。不按同名猜测对象映射。
- 正文白名单提取，业务状态保留，重复投影去重，关系解析不越权；旧 CompanyMemory.md 只参考目录。
- 建立 Company 按访问范围的不可变 generation 与 current 原子指针；完整读取和依赖版本核对成功才发布。
- 实现 index/search/read 与 query_company 的实际能力；不假设远端支持全文搜索或变更订阅。
- 独立 Company 整理 Prompt、结构化输出与语义样本；后台更新不使用私聊内容作公司事实。

## 必需的远端证据

授权范围内的列表和对象响应、类型/域覆盖、人员显示名、关系与状态、分页、撤权/删除/更正行为；使用服务端既有产品身份，不使用个人 Codex 令牌。

本次环境 TKOS_WORLD_API_URL / TKOS_WORLD_AGENT_TOKEN 未作为进程变量配置；未读取隐藏 env 文件寻找凭据。可先实现受控响应适配，真实接口核对前不宣称生产可用。

## 完成定义

- 公司事实相关查询只消费 World/Company，不能读本地旧目标作为回退；页面 Anchor 仍可表达本地内容。
- 列表/详情部分失败不发布残缺投影，读到对象变化不混代，撤权先阻止读取。
- 最终正文与主模型上下文无哈希/来源模板，业务日期和状态没有被错误清理。
- 明确区分“覆盖不足”与“确实没有对象”，主 Agent 无 World 写入工具。
- 离线契约、刷新/失败/权限检查通过；真实读取证据和人工内容核对后才可启用生产。
