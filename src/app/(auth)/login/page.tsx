import { redirect } from "next/navigation";
import Link from "next/link";
import { Cpu } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { LoginForm } from "./form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const user = await getCurrentUser();
  if (user) redirect(searchParams.next || "/dashboard");

  const userCount = await prisma.user.count();
  if (userCount === 0) redirect("/register");

  return (
    <div>
      <Brand />
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Welcome back. Enter your credentials to continue.
      </p>
      <LoginForm next={searchParams.next} />
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="mb-8 flex items-center gap-2">
      <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
        <Cpu className="h-5 w-5" />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold">Homelab</span>
        <span className="text-xs text-muted-foreground">Control Center</span>
      </div>
    </Link>
  );
}
