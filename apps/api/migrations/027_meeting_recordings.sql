-- 02c B2：会议录音 → 火山录音文件识别（说话人分离）→ Meeting 会议记录候选。
-- 状态先后：recording（收分片）→ transcoding（拼接 + ffmpeg）→ uploading（传 TOS）→ transcribing（识别、轮询）→ done；失败为 failed。
-- 音频文件在 MEETING_RECORDING_STORAGE_DIR 卷上，这里只存相对路径（raw_path）、TOS key 与火山任务 id（重启后靠它接着轮询，不重复计费）。
CREATE TABLE meeting_recordings (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings (id),
  status TEXT NOT NULL CHECK (status IN ('recording', 'uploading', 'transcoding', 'transcribing', 'done', 'failed')),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  raw_path TEXT,
  tos_key TEXT,
  asr_task_id TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 结束录音（停止收分片）的时刻
  finished_at TIMESTAMPTZ
);

-- 一场会同一时刻只有一份在途录音；done/failed 留作历史。
CREATE UNIQUE INDEX meeting_recordings_one_active ON meeting_recordings (meeting_id)
  WHERE status IN ('recording', 'uploading', 'transcoding', 'transcribing');

-- Meeting Card 取最近一次录音。
CREATE INDEX meeting_recordings_latest ON meeting_recordings (meeting_id, created_at DESC);
