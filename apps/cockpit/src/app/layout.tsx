import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { operatorName } from "@/lib/context";

// Self-hosted at build time by next/font (no external request, no layout shift).
// Exposed as CSS variables that globals.css maps onto --sans / --mono.
const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "YT Auto Cockpit",
  description: "Operator cockpit for the faceless YouTube automation platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <AppShell operator={operatorName()}>{children}</AppShell>
      </body>
    </html>
  );
}
