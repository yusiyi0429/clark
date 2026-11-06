import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";
import { ChatPage } from "@/components/rail/ChatPage";

export const metadata: Metadata = { title: "对话 · 天枢" };

export default async function Page() {
  await requireMember("/me/chat");
  return <ChatPage />;
}
