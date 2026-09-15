"use client";

import { LockKeyhole, LogOut } from "lucide-react";
import { useFormStatus } from "react-dom";

import { logOut } from "@/app/actions/log-out";
import { cn } from "@/lib/utils";

export function LogOutButton({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <form action={logOut} className={className}>
      <Submit compact={compact} />
    </form>
  );
}

export function LockScreenButton({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <form action={logOut} className={className}>
      <LockSubmit compact={compact} />
    </form>
  );
}

function Submit({ compact }: { compact: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={pending ? "正在退出登录" : "退出登录"}
      className={cn(
        "meta inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-ink-faint",
        "transition-colors duration-fast ease-swift hover:bg-wash-hover hover:text-ink",
        "disabled:cursor-wait disabled:opacity-50",
      )}
    >
      <LogOut className="size-3.5" aria-hidden />
      <span className={compact ? "hidden xl:inline" : undefined}>
        {pending ? "正在退出" : "退出登录"}
      </span>
    </button>
  );
}

function LockSubmit({ compact }: { compact: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={pending ? "正在进入锁屏" : "进入锁屏并重新验证"}
      className={cn(
        "meta inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-ink-faint",
        "transition-colors duration-fast ease-swift hover:bg-wash-hover hover:text-ink",
        "disabled:cursor-wait disabled:opacity-50",
      )}
    >
      <LockKeyhole className="size-3.5" aria-hidden />
      <span className={compact ? "sr-only" : undefined}>
        {pending ? "正在锁屏" : "锁屏"}
      </span>
    </button>
  );
}
