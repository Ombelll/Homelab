import { redirect } from "next/navigation";
import Link from "next/link";
import { Cpu } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { RegisterForm } from "./form";

export const dynamic = "force-dynamic";

// Bootstrap-only: if any user exists, send people to /login.
export default async function RegisterPage() {
  if ((await prisma.user.count()) > 0) redirect("/login");

  return (
    <div>
      <Link href="/" className="mb-8 flex items-center gap-2">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Cpu className="h-5 w-5" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">Homelab</span>
          <span className="text-xs text-muted-foreground">Control Center</span>
        </div>
      </Link>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Create admin account</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        This is the first user on this instance. After this you&rsquo;ll be able to
        invite teammates from Settings (coming soon).
      </p>
      <RegisterForm />
    </div>
  );
}
