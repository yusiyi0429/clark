# 人员目录与历史资料

`company-people.example.json` 是本地联调用的 company-people.v1 示例。生产 COMPANY_PEOPLE_SEED 必须指向真实授权名单；目录缺失、格式不符或 personId 重复时 API 拒绝启动。

`memory/CompanyMemory.md` 作为历史资料保留，API 不再读取它，也不把它作为 World 故障时的公司事实回退。公司正文来自授权 World 读取生成的 Company，见 [ADR-0027](../docs/adr/0027-company-world-and-personal-memory.md)。Compose 只读挂载 seed 供稳定人员目录及已有人工导入流程使用。
