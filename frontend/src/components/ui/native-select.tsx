import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A native `<select>`, styled to the design system.
 *
 * Deliberately native rather than a JS listbox: the option set here is small,
 * closed and known in advance, which is exactly the case the platform control
 * was built for. It is keyboard- and screen-reader-correct with no work, it
 * behaves properly under touch, and it cannot break — which matters on the one
 * screen that has a 30-minute SLA riding on it.
 *
 * (The Base UI listbox in components/ui/select.tsx did not open in this
 * React 19.2 / Base UI 1.7 combination; see DECISIONS.md. Even had it worked,
 * this is the choice that survives contact with a demo.)
 */
export function NativeSelect({
  className,
  children,
  invalid,
  ...props
}: ComponentProps<"select"> & { invalid?: boolean }) {
  return (
    <span className="relative inline-flex w-full items-center">
      <select
        {...props}
        className={cn(
          "h-8 w-full appearance-none rounded-lg border border-rule bg-surface py-1 pr-7 pl-2.5 text-sm text-ink outline-none transition-colors",
          "hover:border-ink-faint focus-visible:border-ink disabled:opacity-50",
          invalid && "border-counter bg-counter-wash text-counter",
          className
        )}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className={cn(
          "pointer-events-none absolute right-2 size-4",
          invalid ? "text-counter" : "text-ink-faint"
        )}
      />
    </span>
  );
}
