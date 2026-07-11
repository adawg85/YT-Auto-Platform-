import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { channels } from "@ytauto/db";
import { AppShell } from "@/components/app-shell";
import { getAppContext, operatorName } from "@/lib/context";

// Inter drives --font-inter (sans); JetBrains Mono drives --font-mono (numbers/metrics).
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
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

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // #23.4: the sidebar "Channels" flyout needs the channel list. Best-effort —
  // if the DB isn't reachable (build, fresh env) the shell renders without a
  // flyout rather than breaking every page.
  let channelLinks: { id: string; name: string }[] = [];
  try {
    const { db } = await getAppContext();
    channelLinks = await db.select({ id: channels.id, name: channels.name }).from(channels);
  } catch {
    channelLinks = [];
  }
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        <AppShell operator={operatorName()} channelLinks={channelLinks}>{children}</AppShell>
      </body>
    </html>
  );
}
