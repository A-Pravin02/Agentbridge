import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentBridge — The Authorization Layer for AI Commerce",
  description: "Merchant AI Commerce Gateway with deterministic financial controls, policy-based authorization, and tamper-evident audit trail.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
