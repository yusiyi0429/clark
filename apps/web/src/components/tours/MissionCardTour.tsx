"use client";

import { PagedTour, PagedTourView } from "./PagedTour";
import { MISSION_CARD_TOUR_STEPS } from "./MissionCardScenes";
import x from "./execution-tour.module.css";

export const MISSION_CARD_TOUR_KEY = "tour:mission-card:owner-confirmation-v2";

function Finish({ onExit }: { onExit: () => void }) {
  return <button type="button" className={x.next} data-ready="true" onClick={onExit} autoFocus>开始查看任务</button>;
}

export function MissionCardTourView({ onExit }: { onExit: () => void }) {
  return <PagedTourView label="任务卡怎么用" steps={MISSION_CARD_TOUR_STEPS} finish={<Finish onExit={onExit} />} onSkip={onExit} />;
}

/** 看完五幕才出现出口，也可以随时跳过；页头问号可再次打开同一演示。 */
export function MissionCardTour({ isOpen, onExit }: { isOpen: boolean; onExit: () => void }) {
  return <PagedTour isOpen={isOpen} label="任务卡怎么用" steps={MISSION_CARD_TOUR_STEPS} finish={<Finish onExit={onExit} />} onSkip={onExit} />;
}
