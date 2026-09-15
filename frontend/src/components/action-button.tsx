"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

/**
 * A button that owns its own in-flight state.
 *
 * §8.3 — pending is expressed by changing the words (`确认并写回` →
 * `正在写回…`), never by a spinner. The label swap also keeps the button width
 * roughly stable, so the page does not jump while a call is in flight.
 *
 * Callers pass an async `onAction`; the button stays disabled until it settles,
 * which is what stops a double-click from firing two state transitions.
 */
export function ActionButton({
  children,
  pendingLabel,
  pending,
  onAction,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick"> & {
  children: ReactNode;
  pendingLabel: string;
  pending: boolean;
  onAction: () => void;
}) {
  return (
    <Button
      {...props}
      disabled={pending || props.disabled}
      onClick={onAction}
      className={cn(className)}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
