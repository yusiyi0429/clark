/**
 * 对话里 Agent 处理时的「当前步骤」（已定设计第 6 节第 2 条）：服务端在工具开始、结束时把它映射成步骤，
 * 发 `{type:"step", id, label, status, result?}` 给界面，整轮的步骤存进 agent_runs，可以回看。
 * - label 是短动词短语（「查企业知识」「读 Mission 卡」），同一类工具并成一步，再次用到时这一步重新变成当前步骤；
 * - result 是这一步实际读到了什么（toolResultDetail，系统生成，不由模型写）；
 * - 这一轮结束时还在进行的步骤：正常结束记 done，停止、出错记 stopped。
 * 没有对应步骤名的工具不显示成步骤。
 * 一个工具里有几步的（对话入口：生成复盘、帮我问问、请同事帮忙，见 conversationEntries.ts）由工具自己报（report），
 * 按 id 更新；这类步骤停在哪一步就是哪一步（「等你确认」「等你选」留着高亮），只有停止、出错时收成 stopped。
 */
export type StepStatus = "done" | "active" | "pending" | "stopped";
export type TurnStep = { id: string; label: string; status: StepStatus; result?: string };

const STEP_LABELS: [RegExp, string][] = [
  [/^(list_sections|search_sections|get_passages)$/, "查企业知识"],
  [/^web_search$/, "查公开来源"],
  [/^read_outlet_feed$/, "读发布方报道"],
  [/^search_people$/, "查人员"],
  [/^get_warmap_overview$/, "读战场总览"],
  [/^list_missions$/, "查 Mission"],
  [/^(read_mission_card|get_mission_card|read_mission_cards)$/, "读 Mission 卡"],
  [/^read_progress$/, "读进展"],
  [/^read_reviews$/, "读复盘"],
  [/^read_object_tree$/, "沿公司地图走"],
  [/^read_anchor$/, "读当前页面"],
  [/^read_issue_conversation$/, "读议题对话"],
  [/^propose_issue$/, "起草议题"],
  [/^list_pending_issues$/, "读待决策议题"],
  [/^(read_ontology|query_company)$/, "查本体"],
  [/^list_business_objects$/, "查业务对象"],
  [/^read_business_object$/, "读业务对象"],
  [/^read_group_evidence$/, "读群材料"],
  [/^read_decision_history$/, "读历史决定"],
  [/^(list_materials|read_material)$/, "读材料"],
  [/^search_personal_memory$/, "查个人记忆"],
  [/^remember_personal_memory$/, "记下来"],
  [/^forget_personal_memory$/, "忘掉"],
  [/^search_conversation_history$/, "找以前的原话"],
  [/^propose_/, "整理确认卡"],
  [/^(edit_|create_|update_|run_|apply_|save_)/, "保存修改"],
];

export function stepLabel(toolName: string): string | undefined {
  return STEP_LABELS.find(([pattern]) => pattern.test(toolName))?.[1];
}

type ToolEvent = { phase: "started" | "completed"; toolCallId: string; name: string; isError?: boolean; detail?: string };

export function createStepTracker(emit: (step: TurnStep) => void) {
  const steps: TurnStep[] = [];
  const running = new Map<string, number>();
  const calls = new Map<string, TurnStep>();
  const reported = new Set<string>();
  const send = (step: TurnStep) => emit({ ...step });
  return {
    tool(event: ToolEvent) {
      if (event.phase === "started") {
        const label = stepLabel(event.name);
        if (!label) return;
        let step = steps.find((item) => item.label === label);
        if (!step) {
          step = { id: `s${steps.length + 1}`, label, status: "active" };
          steps.push(step);
        }
        calls.set(event.toolCallId, step);
        running.set(step.id, (running.get(step.id) ?? 0) + 1);
        if (step.status !== "active") { step.status = "active"; send(step); }
        else if (running.get(step.id) === 1) send(step);
        return;
      }
      const step = calls.get(event.toolCallId);
      if (!step) return;
      calls.delete(event.toolCallId);
      const left = Math.max(0, (running.get(step.id) ?? 1) - 1);
      running.set(step.id, left);
      if (!event.isError && event.detail) step.result = event.detail;
      if (left === 0) { step.status = "done"; send(step); }
    },
    /** 工具自己报的一步：同 id 的后一次取代前一次。 */
    report(next: TurnStep) {
      let step = steps.find((item) => item.id === next.id);
      if (!step) {
        step = { id: next.id, label: next.label, status: next.status };
        steps.push(step);
      }
      reported.add(step.id);
      step.label = next.label;
      step.status = next.status;
      if (next.result) step.result = next.result;
      else delete step.result;
      send(step);
    },
    /** 这一轮结束：还在进行的步骤收尾（stopped：停止或出错）。工具自己报的步骤正常结束时保持原样。 */
    finish(stopped: boolean) {
      for (const step of steps) {
        if (step.status !== "active" || (!stopped && reported.has(step.id))) continue;
        step.status = stopped ? "stopped" : "done";
        send(step);
      }
    },
    list(): TurnStep[] {
      return steps.map((step) => ({ ...step }));
    },
  };
}
