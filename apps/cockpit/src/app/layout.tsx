import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { operatorName } from "@/lib/context";

export const metadata: Metadata = {
  title: "YT Auto Cockpit",
  description: "Operator cockpit for the faceless YouTube automation platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell operator={operatorName()}>{children}</AppShell>
      </body>
    </html>
  );
}
