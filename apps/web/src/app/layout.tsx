import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CEO WarMap",
  description: "CEO 决策驾驶舱",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
