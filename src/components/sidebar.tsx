"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Server,
  Boxes,
  Bell,
  Settings,
  Cpu,
  LogOut,
  Loader2,
  Menu,
  X,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/servers", label: "Servers", icon: Server },
  { href: "/containers", label: "Containers", icon: Boxes },
  { href: "/services", label: "Services", icon: Activity },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/settings", label: "Settings", icon: Settings },
];

type SidebarUser = { id: string; email: string; name: string | null; role: "admin" | "viewer" };

export function Sidebar({ user }: { user: SidebarUser }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer whenever the route changes — handles in-drawer link
  // clicks without listening to each individual <Link>.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Suspend body scroll while the drawer is open (mobile only).
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  return (
    <>
      {/* Desktop sidebar — sticky, always visible at md+. */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-border bg-card/40 px-3 py-6 md:flex md:flex-col">
        <SidebarBody user={user} pathname={pathname} />
      </aside>

      {/* Mobile top bar — visible below md, hosts the hamburger. */}
      <MobileTopBar onOpen={() => setDrawerOpen(true)} />

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          className="fixed inset-0 z-50 md:hidden"
        >
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-background/80"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-card px-3 py-6 shadow-xl">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Close navigation"
            >
              <X className="h-4 w-4" />
            </button>
            <SidebarBody user={user} pathname={pathname} />
          </aside>
        </div>
      ) : null}
    </>
  );
}

function MobileTopBar({ onOpen }: { onOpen: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-card/80 px-4 py-3 backdrop-blur md:hidden">
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Open navigation"
      >
        <Menu className="h-4 w-4" />
      </button>
      <Link href="/" className="flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
          <Cpu className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold">Homelab</span>
      </Link>
    </header>
  );
}

function SidebarBody({ user, pathname }: { user: SidebarUser; pathname: string | null }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function logout() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* fall through; we still redirect below */
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <>
      <Link href="/" className="mb-8 flex items-center gap-2 px-2">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Cpu className="h-5 w-5" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">Homelab</span>
          <span className="text-xs text-muted-foreground">Control Center</span>
        </div>
      </Link>

      <nav className="flex flex-1 flex-col gap-1">
        {nav.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href || (href !== "/" && pathname?.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto space-y-2 px-2 pt-6">
        <Link
          href="/settings/account"
          className="block rounded-md border border-border bg-background/40 px-3 py-2 text-xs hover:bg-accent"
          title="Account settings"
        >
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{user.name || user.email}</span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                user.role === "admin"
                  ? "bg-primary/15 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {user.role}
            </span>
          </div>
          {user.name ? (
            <div className="truncate text-muted-foreground">{user.email}</div>
          ) : null}
        </Link>
        <button
          type="button"
          onClick={logout}
          disabled={signingOut}
          className="inline-flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {signingOut ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <LogOut className="h-3.5 w-3.5" />
          )}
          Sign out
        </button>
        <div className="text-[11px] text-muted-foreground">v1.2.0</div>
      </div>
    </>
  );
}
