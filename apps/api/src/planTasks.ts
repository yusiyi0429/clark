import type { THomePlanTask } from "@warmap/contracts";

/** 首页 Task 行的来源：本体里挂在这些 Mission 下的 Task。 */
export type PlanTaskSource = (missions: { id: string; code: string }[]) => Promise<THomePlanTask[]>;

/** 还没接本体时的来源：一个 Task 都没有。 */
export const emptyPlanTaskSource: PlanTaskSource = async () => [];
