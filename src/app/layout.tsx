import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Homelab Control Center",
  description: "Self-hosted dashboard for monitoring homelab servers and containers",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Auth pages (/login, /register) render before a session exists. When there
  // is no user we drop the sidebar so the (auth) layout owns the viewport.
  const user = await getCurrentUser();

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {user ? (
          <div className="flex min-h-screen">
            <Sidebar user={user} />
            <main className="flex-1 overflow-x-hidden">
              <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
                {children}
              </div>
            </main>
          </div>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
