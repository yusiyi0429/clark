"use client";

import { PagedTour, PagedTourView } from "./PagedTour";
import { TOUR_STEPS } from "./TourScenes";
import x from "./execution-tour.module.css";

export const EXECUTION_TOUR_KEY = "tour:execution-items";
export type TourExit = "start" | "later";

function Finish({ onExit }: { onExit: (exit: TourExit) => void }) {
  return <>
    <button type="button" className={x.textButton} onClick={() => onExit("later")}>稍后再说</button>
    <button type="button" className={x.next} data-ready="true" onClick={() => onExit("start")} autoFocus>开启我的第一件</button>
  </>;
}

/** 六幕与原演示保持一致：看完才可开启第一件或稍后再说。 */
export function ExecutionItemsTourView({ onExit }: { onExit: (exit: TourExit) => void }) {
  return <PagedTourView label="执行事项怎么用" steps={TOUR_STEPS} finish={<Finish onExit={onExit} />} />;
}

export function ExecutionItemsTour({ isOpen, onExit }: { isOpen: boolean; onExit: (exit: TourExit) => void }) {
  return <PagedTour isOpen={isOpen} label="执行事项怎么用" steps={TOUR_STEPS} finish={<Finish onExit={onExit} />} />;
}
