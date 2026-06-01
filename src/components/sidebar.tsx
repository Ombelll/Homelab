"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  Server,
  Boxes,
  Bell,
  Settings,
  Cpu,
  LogOut,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/servers", label: "Servers", icon: Server },
  { href: "/containers", label: "Containers", icon: Boxes },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({
  user,
}: {
  user: { id: string; email: string; name: string | null };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function logout() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* even if the API call fails, the cookie clear below sends us to /login */
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-border bg-card/40 px-3 py-6 md:flex md:flex-col">
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
        <div className="rounded-md border border-border bg-background/40 px-3 py-2 text-xs">
          <div className="truncate font-medium">{user.name || user.email}</div>
          {user.name ? (
            <div className="truncate text-muted-foreground">{user.email}</div>
          ) : null}
        </div>
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
        <div className="text-[11px] text-muted-foreground">v0.3.0</div>
      </div>
    </aside>
  );
}
