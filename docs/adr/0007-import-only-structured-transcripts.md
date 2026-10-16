# 标准逐字稿与受控输入

标准逐字稿契约继续有效。当前实现另有录音转写路径，见[会议输入](../architecture/README.md#会议输入)。下文“不建设录音、ASR”仅记录最初范围，不作为当前功能限制。

Meeting 只接受 `warmap-transcript.v1`，所有 speakerId 必须匹配已有 participant，任一字段不兼容就整份解析失败。MVP 不建设录音、ASR、通用格式转换或说话人猜测/别名词典，从而让会后决定、负责人和 CEO 判断都建立在明确身份的发言段上。

## 受限的妙记 Markdown 例外

CEO 可以把妙记导出的 Markdown 上传为 Meeting 内嵌候选（`meetings.transcript_candidate`），由服务端做确定性转换后经 CEO 显式确认，才写入标准 Transcript：

- 解析只识别固定结构：`### 文字记录` 之后的 `姓名 mm:ss` / `姓名 hh:mm:ss` 行加后续正文；不含自由文本抽取、录音、ASR、OCR 或姓名猜测。结构错误整份拒绝并返回行号，不保存部分结果。
- 说话人只按 displayName 与企业知识人员目录做精确匹配；0 个或 ≥2 个命中都标为 unresolved，必须由 CEO 在确认 Action 中手工给出 `speakerMappings`。
- 上传 Markdown 只生成候选并 bump Meeting version，不改 status、不启动会后抽取。只有 `meeting.confirm_transcript_candidate` 才在同一事务内补齐 participants、写入标准 `warmap-transcript.v1`（`startedAt = 当前 scheduledAt + offsetSeconds`）、清候选并把 Meeting 置为 held；提交后才启动既有 Outcome Agent。
- 确认后的 Transcript 增加可选 `source` 元数据留痕；原始 Markdown 不复制进 Card/Action JSON，也不落独立文件库。

除此之外的边界不变：仍不支持任意会议纪要格式、DOCX/PDF Transcript、别名字典或模糊匹配；Json multipart 直接导入与 DRI service 导入行为不变；会后抽取只读最终 Transcript，不读会前材料。
