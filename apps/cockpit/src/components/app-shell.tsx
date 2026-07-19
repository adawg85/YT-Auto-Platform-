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

export function AppShell({
  operator,
  channelLinks = [],
  version,
  children,
}: {
  operator: string;
  /** #23.4: channels for the sidebar hover flyout (empty → no flyout) */
  channelLinks?: { id: string; name: string }[];
  /** deployed build per service, so the operator can see what's live */
  version?: { cockpit: string; worker: { commit: string; bootedAt: string } | null };
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
          {/* desktop utility cluster — the top bar is hidden on desktop, so
              live status + alerts live here (mobile keeps them in the top bar) */}
          <div className="side-util">
            <SystemStatus />
            <Link href="/alerts" className="icon-btn" title="Alerts" aria-label="Alerts">
              <IconBell />
            </Link>
          </div>
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
          {version && <BuildBadge version={version} />}
        </div>
      </aside>
      <div className={`scrim${open ? " open" : ""}`} onClick={() => setOpen(false)} />

      <main className="main">
        {/* mobile-only utility bar (hidden on desktop via CSS): the sidebar is a
            drawer on mobile, so the hamburger + live status + alerts live here */}
        <header className="topbar">
          <button className="icon-btn hamburger" onClick={() => setOpen((v) => !v)}>
            <IconMenu />
          </button>
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

function relTime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Deployed-build badge (2026-07-19 operator: "add the deploy version so I can
 * tell"). Shows the cockpit build and the worker (pipeline) build side by side;
 * the dot is green when they match (fully deployed) and amber while the worker
 * is still on an older commit (mid-deploy) — so a pipeline fix isn't tested
 * before it's actually live.
 */
function BuildBadge({
  version,
}: {
  version: { cockpit: string; worker: { commit: string; bootedAt: string } | null };
}) {
  const w = version.worker;
  const inSync = !!w && w.commit === version.cockpit;
  return (
    <div
      title={
        w
          ? inSync
            ? "App and pipeline are on the same build — fully deployed."
            : "Pipeline (worker) is still on an older build — a pipeline fix isn't live yet."
          : "Worker build unknown (not booted yet)."
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px 2px",
        fontSize: 10.5,
        opacity: 0.75,
        fontFamily: "var(--font-mono)",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          flex: "none",
          background: inSync ? "var(--good, #16a34a)" : "var(--warn, #d97706)",
        }}
      />
      <span>
        app {version.cockpit} · worker {w ? w.commit : "?"}
        {w ? ` · ${relTime(w.bootedAt)}` : ""}
      </span>
    </div>
  );
}
