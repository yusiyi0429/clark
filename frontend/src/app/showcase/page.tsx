import type { Metadata } from "next";

import { ShowcaseView } from "./showcase-view";

export const metadata: Metadata = {
  title: "Showcase · TKOS",
  robots: { index: false, follow: false },
};

export default function ShowcasePage() {
  return <ShowcaseView />;
}
