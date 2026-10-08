\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('monthly-review:create'));
SELECT id FROM battlefield_config WHERE id='growth' FOR UPDATE;
SELECT id FROM monthly_plans WHERE id='d5a09015-4e30-4979-926c-c3bc08c5d55a' FOR UPDATE;
SELECT id FROM monthly_reviews WHERE id='6807d697-478b-49d7-adc2-1fce826ab737' FOR UPDATE;
SELECT id FROM monthly_review_items WHERE id='ae781b21-3bea-4091-bf0b-ffae5fd1cc92' FOR UPDATE;

DO $guard$
BEGIN
 IF (SELECT md5(to_jsonb(b)::text) FROM battlefield_config b WHERE id='growth') IS DISTINCT FROM '79a7540e6b7926e012870e39f93f97fa' THEN RAISE EXCEPTION 'Battlefield changed since backup'; END IF;
 IF (SELECT md5(to_jsonb(p)::text) FROM monthly_plans p WHERE id='d5a09015-4e30-4979-926c-c3bc08c5d55a') IS DISTINCT FROM '2a12a70d2e6d2c8cc6564105ce7cbd2d' THEN RAISE EXCEPTION 'Plan changed since backup'; END IF;
 IF (SELECT md5(to_jsonb(i)::text) FROM monthly_review_items i WHERE id='ae781b21-3bea-4091-bf0b-ffae5fd1cc92') IS DISTINCT FROM '6b6f4ac73e54ed74236029aeca98e757' THEN RAISE EXCEPTION 'Review item changed since backup'; END IF;
 IF (SELECT md5(to_jsonb(r)::text) FROM monthly_reviews r WHERE id='6807d697-478b-49d7-adc2-1fce826ab737') IS DISTINCT FROM '02e77147f5f329812dd70b5ea4d497dc' THEN RAISE EXCEPTION 'Review changed since backup'; END IF;
 IF EXISTS (SELECT 1 FROM monthly_review_comments WHERE item_id='ae781b21-3bea-4091-bf0b-ffae5fd1cc92') THEN RAISE EXCEPTION 'Review item has human comments'; END IF;
 IF EXISTS (SELECT 1 FROM agent_runs WHERE status='running' AND input_snapshot::text ~ '("growth"|增长战场)') THEN RAISE EXCEPTION 'A related agent run is still active'; END IF;
 IF NOT EXISTS (SELECT 1 FROM monthly_plans p JOIN agent_runs a ON a.id='8941375c-abb1-43ad-9ba1-017dc4b21d4a'
  WHERE p.id='d5a09015-4e30-4979-926c-c3bc08c5d55a' AND p.status='negotiating'
    AND p.company_outcome=a.candidate_output->>'companyOutcome' AND p.battlefields=a.candidate_output->'battlefields'
    AND a.input_snapshot->'companyMemory'='[]'::jsonb AND a.input_snapshot->'battlefields'->0->>'battlefieldId'='growth')
 THEN RAISE EXCEPTION 'Plan is not the unchanged draft derived from the fixture'; END IF;
END
$guard$;

CREATE FUNCTION pg_temp.unaffected_data() RETURNS jsonb LANGUAGE sql AS $snapshot$
SELECT jsonb_build_object(
 'battlefields',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM battlefield_config t WHERE id<>'growth'),
 'plans',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM monthly_plans t WHERE id<>'d5a09015-4e30-4979-926c-c3bc08c5d55a'),
 'reviews',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM monthly_reviews t WHERE id<>'6807d697-478b-49d7-adc2-1fce826ab737'),
 'reviewItems',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM monthly_review_items t WHERE id<>'ae781b21-3bea-4091-bf0b-ffae5fd1cc92'),
 'reviewComments',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM monthly_review_comments t),
 'missions',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM missions t),
 'tasks',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM tasks t),
 'issues',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM issues t),
 'meetings',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM meetings t),
 'capabilities',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM capability_config t),
 'radar',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM radar_config t),
 'conversations',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM conversations t),
 'messages',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY conversation_id,sequence),'[]'::jsonb)::text) FROM conversation_messages t),
 'agentRuns',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM agent_runs t)
);
$snapshot$;
CREATE TEMP TABLE unaffected_before AS SELECT pg_temp.unaffected_data() AS value;
CREATE TEMP TABLE scope_before AS
 SELECT (SELECT to_jsonb(p) FROM monthly_plans p WHERE id='d5a09015-4e30-4979-926c-c3bc08c5d55a') AS plan,
        (SELECT to_jsonb(r) FROM monthly_reviews r WHERE id='6807d697-478b-49d7-adc2-1fce826ab737') AS review;

UPDATE monthly_plans p SET company_outcome='',
 battlefields=(SELECT coalesce(jsonb_agg(value ORDER BY position),'[]'::jsonb) FROM jsonb_array_elements(p.battlefields) WITH ORDINALITY a(value,position) WHERE value->>'battlefieldId'<>'growth'),
 negotiation=jsonb_set(jsonb_set(p.negotiation,'{checkedItemIds}',
  (SELECT coalesce(jsonb_agg(value ORDER BY position),'[]'::jsonb) FROM jsonb_array_elements(p.negotiation->'checkedItemIds') WITH ORDINALITY a(value,position) WHERE value NOT IN ('"company"'::jsonb,'"battlefield:growth"'::jsonb))),
  '{edits}',(p.negotiation->'edits') || jsonb_build_array(jsonb_build_object('at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'fields',jsonb_build_array('companyOutcome','battlefields','checkedItemIds')))),
 generation=p.generation || jsonb_build_object('status','failed','error',jsonb_build_object('code','DEMO_DATA_REMOVED','message','已清理历史演示目标，请根据真实战略目标重新起草本月计划。','at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
 version=version+1,updated_at=clock_timestamp()
 WHERE id='d5a09015-4e30-4979-926c-c3bc08c5d55a' AND version=8;
DELETE FROM monthly_review_items WHERE id='ae781b21-3bea-4091-bf0b-ffae5fd1cc92' AND subject_type='battlefield' AND subject_id='growth' AND version=2 AND status='draft' AND history='[]'::jsonb AND action_fingerprints='[]'::jsonb AND submitted_at IS NULL;
UPDATE monthly_reviews SET version=version+1,updated_at=clock_timestamp() WHERE id='6807d697-478b-49d7-adc2-1fce826ab737' AND version=1;
DELETE FROM battlefield_config WHERE id='growth' AND version=1 AND owner_id='' AND code='' AND mission_anchors='[]'::jsonb;

DO $verify$
DECLARE source record; matches bigint;
BEGIN
 IF pg_temp.unaffected_data() IS DISTINCT FROM (SELECT value FROM unaffected_before) THEN RAISE EXCEPTION 'Unrelated data changed'; END IF;
 IF NOT EXISTS (SELECT 1 FROM monthly_plans p CROSS JOIN scope_before b
  WHERE p.id='d5a09015-4e30-4979-926c-c3bc08c5d55a' AND p.version=9 AND p.company_outcome='' AND p.battlefields='[]'::jsonb
    AND p.generation->>'status'='failed' AND p.negotiation->'checkedItemIds'='[]'::jsonb
    AND (to_jsonb(p)-ARRAY['version','updated_at','company_outcome','battlefields','negotiation','generation'])=(b.plan-ARRAY['version','updated_at','company_outcome','battlefields','negotiation','generation'])
    AND (p.negotiation-ARRAY['edits','checkedItemIds'])=((b.plan->'negotiation')-ARRAY['edits','checkedItemIds']))
 THEN RAISE EXCEPTION 'Plan cleanup did not produce expected state'; END IF;
 IF NOT EXISTS (SELECT 1 FROM monthly_reviews r CROSS JOIN scope_before b
  WHERE r.id='6807d697-478b-49d7-adc2-1fce826ab737' AND r.version=2
    AND (to_jsonb(r)-ARRAY['version','updated_at'])=(b.review-ARRAY['version','updated_at']))
 THEN RAISE EXCEPTION 'Review scope changed unexpectedly'; END IF;
 FOR source IN SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'
  AND table_name NOT IN ('agent_runs','conversations','conversation_messages')
 LOOP
  EXECUTE format('SELECT count(*) FROM %I.%I t WHERE row_to_json(t)::text ~ ''("growth"|增长战场)''',source.table_schema,source.table_name) INTO matches;
  IF matches<>0 THEN RAISE EXCEPTION 'Residual reference in table %: %',source.table_name,matches; END IF;
 END LOOP;
END
$verify$;
SELECT jsonb_build_object('growthBattlefields',(SELECT count(*) FROM battlefield_config WHERE id='growth'),
 'growthReviewItems',(SELECT count(*) FROM monthly_review_items WHERE subject_type='battlefield' AND subject_id='growth'),
 'remainingBattlefields',(SELECT jsonb_agg(name ORDER BY sort_order,id) FROM battlefield_config),
 'remainingTasks',(SELECT count(*) FROM tasks),'remainingMissions',(SELECT count(*) FROM missions),
 'unrelatedDataUnchanged',pg_temp.unaffected_data()=(SELECT value FROM unaffected_before)) AS verification;
COMMIT;
