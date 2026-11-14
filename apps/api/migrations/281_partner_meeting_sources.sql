-- 飞书场次事件提供的原始标识与妙记自带的来源标识分开。旧轮询也会写 feishu_meeting_id，不能用它证明场次。
ALTER TABLE meetings ADD COLUMN feishu_live_meeting_id text,
  ADD COLUMN minute_source_meeting_id text,
  ADD COLUMN minute_binding text CHECK (minute_binding IN ('source_id','owner','unverified')),
  ADD COLUMN invited_person_ids text[];
ALTER TABLE feishu_minute_inbox ADD COLUMN source_url text;
-- 同一场会先有确认逐字稿时，另一份录音的原始转写按原录音保存。
ALTER TABLE meeting_recordings ADD COLUMN transcript_candidate jsonb;

-- 旧数据只认能证明的显式选择。旧版自动匹配也会写 attached，但只有所有者操作才有此摄取任务。
UPDATE meetings m SET minute_source_meeting_id = i.feishu_meeting_id, minute_binding = 'owner'
FROM feishu_minute_inbox i WHERE m.id = i.meeting_id AND m.minute_token = i.minute_token AND
 (i.status = 'organized' OR (i.status = 'attached' AND EXISTS (
    SELECT 1 FROM jobs j WHERE j.kind = 'meeting.minute_inbox_ingest'
      AND j.dedupe_key = 'meeting.minute_inbox_ingest:' || i.minute_token)));
-- 历史会议事件必须通过本地日程或入会号定位。快照中的会议号不能充当独立证据。
WITH live AS (
  SELECT COALESCE(payload->'event',payload) AS body FROM feishu_events
  WHERE event_type IN ('vc.meeting.meeting_started_v1','vc.meeting.meeting_ended_v1','vc.meeting.all_meeting_started_v1','vc.meeting.all_meeting_ended_v1')
), records AS (SELECT COALESCE(body->'meeting',body) AS e FROM live), unique_events AS (
  SELECT m.id, min(COALESCE(e->>'id', e->>'meeting_id')) AS source_id FROM meetings m JOIN records
  ON e->>'calendar_event_id' = m.feishu_event_id OR NULLIF(e->>'meeting_no','') = substring(m.feishu_event_join_url from '/j/([0-9]+)')
  WHERE NULLIF(COALESCE(e->>'id',e->>'meeting_id'),'') IS NOT NULL
  GROUP BY m.id HAVING count(DISTINCT COALESCE(e->>'id',e->>'meeting_id')) = 1
)
UPDATE meetings m SET feishu_live_meeting_id = u.source_id FROM unique_events u WHERE m.id = u.id;
UPDATE meetings m SET minute_source_meeting_id = i.feishu_meeting_id
FROM feishu_minute_inbox i WHERE m.minute_token = i.minute_token AND m.minute_source_meeting_id IS NULL;
WITH events AS (SELECT COALESCE(payload->'event',payload) AS e FROM feishu_events WHERE event_type='minutes.minute.generated_v1'),
minute_sources AS (
 SELECT COALESCE(e->>'minute_token',e#>>'{minute,token}') AS token,
   COALESCE(e#>>'{generated_source,source_entity_id}', e#>>'{minute_source,source_entity_id}') AS source_id FROM events
)
UPDATE meetings m SET minute_source_meeting_id=s.source_id FROM minute_sources s WHERE m.minute_token=s.token
 AND m.minute_source_meeting_id IS NULL AND s.source_id IS NOT NULL;
UPDATE meetings m SET minute_binding = CASE WHEN feishu_live_meeting_id=minute_source_meeting_id AND NOT EXISTS
 (SELECT 1 FROM meetings other WHERE other.id<>m.id AND other.status<>'cancelled' AND other.feishu_live_meeting_id=m.feishu_live_meeting_id)
 THEN 'source_id' ELSE 'unverified' END
WHERE minute_token IS NOT NULL AND minute_binding IS NULL;
UPDATE feishu_minute_inbox i SET status='pending',meeting_id=NULL FROM meetings m
 WHERE i.status='attached' AND i.minute_token=m.minute_token AND m.minute_binding='unverified';
CREATE INDEX meetings_feishu_live_id ON meetings(feishu_live_meeting_id) WHERE feishu_live_meeting_id IS NOT NULL;
-- 历史参会快照默认包含 CEO。只有主持、创建或实际参会才是可以订阅的独立证据。
UPDATE meetings m SET invited_person_ids=ARRAY(SELECT p->>'personId' FROM jsonb_array_elements(m.participants) p
  WHERE p->>'personId' <> m.ceo_participant_id OR p->>'personId' IN (m.lead_dri_id,m.created_by)
    OR EXISTS (SELECT 1 FROM thread_members t WHERE t.object_type='meeting' AND t.object_id=m.id::text
      AND t.person_id=p->>'personId' AND t.left_at IS NULL AND t.added_by<>'meeting'));
