import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { PwaRegister } from "@/components/pwa-register";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Homelab Control Center",
  description: "Self-hosted dashboard for monitoring homelab servers and containers",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Homelab" },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Auth pages (/login, /register) render before a session exists. When there
  // is no user we drop the sidebar so the (auth) layout owns the viewport.
  const user = await getCurrentUser();

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <PwaRegister />
        {user ? (
          <div className="flex min-h-screen flex-col md:flex-row">
            <Sidebar user={user} />
            <main className="flex-1 overflow-x-hidden">
              <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
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
