import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentBridge — The Authorization Layer for AI Commerce",
  description:
    "Deterministic authorization, human approval and a tamper-evident audit trail for AI agents that spend money.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
