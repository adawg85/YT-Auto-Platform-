"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { LiveRefresh } from "./live-refresh";
import { SystemStatus } from "./system-status";
import {
  IconOverview,
  IconChannels,
  IconReview,
  IconSparkle,
  IconTrend,
  IconMarketing,
  IconUgc,
  IconAssistant,
  IconAccount,
  IconBell,
  IconMoon,
  IconMenu,
} from "./icons";

const NAV_TOP = [
  { href: "/", label: "Overview", Icon: IconOverview, match: (p: string) => p === "/" },
  { href: "/channels", label: "Channels", Icon: IconChannels, match: (p: string) => p.startsWith("/channels") },
  { href: "/ideas", label: "Ideas", Icon: IconSparkle, match: (p: string) => p.startsWith("/ideas") },
  { href: "/gates", label: "Review", Icon: IconReview, match: (p: string) => p.startsWith("/gates") || p.startsWith("/alerts") || p.startsWith("/productions") },
  { href: "/market", label: "Market intel", Icon: IconTrend, match: (p: string) => p.startsWith("/market") },
];
const NAV_SOON = [
  { label: "Marketing", Icon: IconMarketing },
  { label: "UGC", Icon: IconUgc },
];

const CRUMB: Record<string, string> = {
  "": "Portfolio",
  channels: "Channels",
  gates: "Review",
  alerts: "Alerts",
  market: "Market intel",
  ideas: "Ideas",
  costs: "Costs",
  productions: "Video",
  assistant: "Assistant",
  account: "Account & keys",
};

export function AppShell({
  operator,
  channelLinks = [],
  children,
}: {
  operator: string;
  /** #23.4: channels for the sidebar hover flyout (empty → no flyout) */
  channelLinks?: { id: string; name: string }[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem("theme") : null;
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  }, []);

  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme");
    const isDark = cur ? cur === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  }

  const seg = pathname.split("/")[1] ?? "";
  const crumb = CRUMB[seg] ?? "Portfolio";
  const initial = (operator[0] ?? "o").toUpperCase();

  return (
    <div className="app">
      <LiveRefresh />
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="brand">
          <span className="logo">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
              <polygon points="6 4 20 12 6 20 6 4" />
            </svg>
          </span>
          YT&nbsp;Auto
        </div>
        <nav className="nav">
          <div className="nav-label">Automated YouTube</div>
          {NAV_TOP.map(({ href, label, Icon, match }) => {
            const link = (
              <Link key={href} href={href} className={match(pathname) ? "active" : ""}>
                <Icon />
                {label}
              </Link>
            );
            // #23.4: hovering "Channels" pops a flyout listing every channel
            // for direct jump (CSS :hover — no state, works without JS)
            if (href !== "/channels" || channelLinks.length === 0) return link;
            return (
              <div key={href} className="nav-fly">
                {link}
                <div className="nav-flyout">
                  <div className="nav-flyout-h">Channels</div>
                  {channelLinks.slice(0, 12).map((c) => (
                    <Link key={c.id} href={`/channels/${c.id}`}>
                      {c.name}
                    </Link>
                  ))}
                  <Link href="/channels" className="all">
                    All channels →
                  </Link>
                </div>
              </div>
            );
          })}
          <div className="nav-label">Business lines</div>
          {NAV_SOON.map(({ label, Icon }) => (
            <a key={label} aria-disabled style={{ cursor: "default", opacity: 0.65, pointerEvents: "none" }}>
              <Icon />
              {label}
              <span className="soon">Soon</span>
            </a>
          ))}
        </nav>
        <div className="nav-bottom">
          <nav className="nav" style={{ padding: "0 0 8px" }}>
            <Link href="/assistant" className={pathname.startsWith("/assistant") ? "active" : ""}>
              <IconAssistant />
              Assistant
            </Link>
            <Link href="/account" className={pathname.startsWith("/account") ? "active" : ""}>
              <IconAccount />
              Account &amp; keys
            </Link>
          </nav>
          <div className="op">
            <span className="av">{initial}</span>
            <span className="who">
              {operator}
              <small>Operator</small>
            </span>
            <button className="icon-btn" onClick={toggleTheme} title="Toggle theme" style={{ marginLeft: "auto", width: 30, height: 30 }}>
              <IconMoon />
            </button>
          </div>
        </div>
      </aside>
      <div className={`scrim${open ? " open" : ""}`} onClick={() => setOpen(false)} />

      <main className="main">
        <header className="topbar">
          <button className="icon-btn hamburger" onClick={() => setOpen((v) => !v)}>
            <IconMenu />
          </button>
          <div className="crumb">
            <b>{crumb}</b>
          </div>
          <div className="spacer" />
          <SystemStatus />
          <Link href="/alerts" className="icon-btn" title="Alerts" aria-label="Alerts">
            <IconBell />
          </Link>
        </header>
        <div className="view">{children}</div>
      </main>
    </div>
  );
}
