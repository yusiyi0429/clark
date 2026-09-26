"use client";

import { Button, Tooltip } from "@heroui/react";
import type { ComponentProps } from "react";

/** HeroUI 按钮；带 title 时换成可访问的 HeroUI Tooltip，按钮仍是同一个 DOM 节点（clark `concept-control.tsx` 同）。 */
export function HeroButton({ title, ...props }: ComponentProps<typeof Button> & { title?: string }) {
  if (!title) return <Button {...props} />;
  return (
    <Tooltip>
      <Button {...props} />
      <Tooltip.Content>{title}</Tooltip.Content>
    </Tooltip>
  );
}
