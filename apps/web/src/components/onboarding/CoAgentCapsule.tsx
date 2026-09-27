"use client";

import { SiriWave } from "./SiriWave";
import s from "./foundation.module.css";

/** 概念版 C-07 的胶囊材质；引导不携带会议的行为或按钮。 */
export function CoAgentCapsule({ state = "idle", level = 0, acknowledge = 0 }: {
  state?: "idle" | "listening";
  level?: number;
  acknowledge?: number;
}) {
  return <div className={s.capsule} aria-hidden="true">
    <div className={s.capsuleGlass} data-state={state}>
      <div key={acknowledge} className={acknowledge ? s.acknowledge : s.capsuleBody}>
        <span className={s.sheen} />
        {state === "listening" ? <SiriWave energy={level} className={s.wave} /> : <><span className={s.idleLight} /><span className={s.ambientLight} /></>}
      </div>
    </div>
  </div>;
}
