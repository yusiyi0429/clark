"use client";

/**
 * 「授权天枢替你记进本体」（前端交互说明 10a 第 7 步）的步骤框架：只占位置，不实现授权逻辑。
 * 本体的网页授权页确认之后，「去授权」跳过去、本人确认后跳回；在那之前这一步默认隐藏（API 的 ONBOARDING_DELEGATION_STEP）。
 */
import f from "./foundation.module.css";
import c from "./setup.module.css";

export const DELEGATION_SCOPES = ["建对象", "修订", "门", "指派", "生命周期", "议题"] as const;

export function DelegationPanel() {
  return <div className={`${f.glass} ${c.panel}`} data-slot="delegation">
    <ul className={c.scopes} aria-label="授权范围">{DELEGATION_SCOPES.map((scope) => <li key={scope}>{scope}</li>)}</ul>
    <div className={c.delegationFoot}>
      <span className={c.count}>有效期至 12 月 31 日</span>
      <button type="button" className={c.action} disabled>去本体授权</button>
    </div>
  </div>;
}
