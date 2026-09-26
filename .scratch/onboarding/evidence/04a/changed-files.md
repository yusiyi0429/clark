# 04a 改动文件清单

所有路径相对仓库根目录。未改候选 JSON、API 声纹文件、依赖锁文件。

## 迁移

- `apps/api/migrations/032_mission_card_fields.sql`
- `apps/api/migrations/033_mission_rounds.sql`
- `apps/api/migrations/034_mission_card_discussion.sql`

## 契约与生成客户端

- `apps/web/src/lib/api/openapi.json`
- `apps/web/src/lib/api/schema.d.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/missionCards.ts`
- `packages/contracts/src/missions.ts`
- `packages/contracts/src/openapi.ts`
- `packages/contracts/test/contract.test.ts`
- `packages/contracts/test/missionCards.test.ts`

## API、测试与配置

- `.env.example`
- `apps/api/migrations/032_mission_card_fields.sql`
- `apps/api/migrations/033_mission_rounds.sql`
- `apps/api/migrations/034_mission_card_discussion.sql`
- `apps/api/package.json`
- `apps/api/scripts/import-mission-card-drafts.ts`
- `apps/api/src/app.ts`
- `apps/api/src/battlefields.ts`
- `apps/api/src/missionRoundScheduler.ts`
- `apps/api/src/missionRounds.ts`
- `apps/api/src/missions.ts`
- `apps/api/src/routes/cards.ts`
- `apps/api/src/routes/missionCards.ts`
- `apps/api/src/server.ts`
- `apps/api/test/helpers.ts`
- `apps/api/test/migrate.test.ts`
- `apps/api/test/missionCardMigrations.test.ts`
- `apps/api/test/missionDraftHome.test.ts`
- `apps/api/test/missionDraftScript.test.ts`
- `apps/api/test/missionRoundGuards.test.ts`
- `apps/api/test/missionRoundHomeMerge.test.ts`
- `apps/api/test/missionRoundRoutes.test.ts`
- `apps/api/test/missionRoundScheduler.test.ts`
- `apps/api/test/missionRounds.test.ts`
- `infra/docker-compose.yml`

## Web 与测试

- `apps/web/src/app/(ceo)/missions/MissionOverviewScreen.tsx`
- `apps/web/src/app/(ceo)/missions/[id]/MissionDetailScreen.tsx`
- `apps/web/src/app/(ceo)/missions/[id]/missionDetail.test.tsx`
- `apps/web/src/app/(ceo)/missions/missionOverview.test.tsx`
- `apps/web/src/app/config/missions/MissionManagementScreen.tsx`
- `apps/web/src/app/config/missions/missionManagement.test.tsx`
- `apps/web/src/components/MissionStatus.tsx`
- `apps/web/src/components/NotificationRail.tsx`
- `apps/web/src/components/missionRoundEntry.test.tsx`
- `apps/web/src/components/notificationSummary.test.tsx`
- `apps/web/src/components/shell/CeoWorkspace.tsx`
- `apps/web/src/lib/actionResponse.test.ts`
- `apps/web/src/lib/actionResponse.ts`
- `apps/web/src/lib/api/openapi.json`
- `apps/web/src/lib/api/schema.d.ts`
- `apps/web/src/lib/useCardAction.test.tsx`
- `apps/web/src/lib/useCardAction.tsx`
- `apps/web/src/styles/mission-status.module.css`

## 文档

- `.scratch/onboarding/issues/04a-mission-rounds-data-and-drafts.md`
- `.scratch/onboarding/map.md`
- `CONTEXT.md`
- `docs/adr/0019-promote-mission-to-core-entity.md`
- `docs/adr/0020-members-sign-in-and-own-execution-items.md`
- `docs/adr/0022-persist-monthly-mission-card-rounds.md`

## 验收证据

- `.scratch/onboarding/evidence/04a/baseline.md`
- `.scratch/onboarding/evidence/04a/browser-server.ts`
- `.scratch/onboarding/evidence/04a/changed-files.md`
- `.scratch/onboarding/evidence/04a/report.md`

另保存同目录 01–08 八张 PNG、`api-final.log`、`api-final-isolated.log`、`api-final-complete.log`、`api-final-threads.log`，以及最终 `api-batches.log` / `api-batch-01.log` 至 `api-batch-10.log`；图片和日志受仓库现有忽略规则管理，已留在本地供验收，不调整 `.gitignore`。
