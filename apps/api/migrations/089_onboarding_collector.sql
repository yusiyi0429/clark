-- 上手流程「安装采集器 → 后台扫描 → 最后一页三个清单」（前端交互说明 10a、第 7 节 ③ 搬家、第 8 节工作依据清单）。

-- 本机清单加一类：记忆文件的盘点（只有路径、大小、修改时间，不含正文；正文由记忆导入那一步经本人同意后再传）。
ALTER TABLE local_inventory DROP CONSTRAINT local_inventory_kind_check;
ALTER TABLE local_inventory ADD CONSTRAINT local_inventory_kind_check CHECK (kind IN ('scheduled_task', 'feishu_doc', 'memory_file'));

-- 每台设备最近一次完整盘点的时刻：上手的扫描页据此判断扫完没有；last_seen_at 早于它的定时任务、记忆文件已经不在本机了。
CREATE TABLE collector_scans (
  person_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (person_id, device_id)
);

-- 工作依据清单：本人确认在依据的整份文档，记下确认时的修订号。天枢材料的 revision 是 v 版本号；
-- 飞书文档按本人身份读元数据（drive:drive.metadata:readonly，不读正文），记下确认时的最近修订时间 revised_at 和修订人 revised_by（名字），读不到时为空。
-- doc_kind：material 天枢里的材料（doc_ref 是材料 id）；feishu_doc 飞书文档、link 其他链接（doc_ref 是地址）。
CREATE TABLE work_basis (
  id UUID PRIMARY KEY,
  person_id TEXT NOT NULL,
  doc_kind TEXT NOT NULL CHECK (doc_kind IN ('material', 'feishu_doc', 'link')),
  doc_ref TEXT NOT NULL CHECK (char_length(doc_ref) BETWEEN 1 AND 500),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
  url TEXT,
  revision TEXT,
  revised_at TIMESTAMPTZ,
  revised_by TEXT,
  confirmed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (person_id, doc_kind, doc_ref)
);

-- 定时任务区的最小一张表：现在只有上手「搬家」写进来的旧定时任务（source=local，来自某台设备的本机清单）。
CREATE TABLE schedules (
  id UUID PRIMARY KEY,
  person_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  cadence TEXT,
  command TEXT,
  source TEXT NOT NULL CHECK (source IN ('local')),
  source_device_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (person_id, source, source_device_id, source_key)
);
