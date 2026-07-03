import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "YT Auto Cockpit",
  description: "Operator cockpit for the faceless YouTube automation platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="topnav">
          <span className="brand">▶ ytauto</span>
          <Link href="/gates">Gates</Link>
          <Link href="/ideas">Ideas</Link>
          <Link href="/channels">Channels</Link>
          <Link href="/costs">Costs</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
