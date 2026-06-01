import Link from "next/link";
import { Cpu } from "lucide-react";
import { consumeInvite } from "@/lib/invites";
import { AcceptInviteForm } from "./form";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: { token: string } }) {
  const probe = await consumeInvite(params.token);

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

      {!probe.ok ? (
        <>
          <h1 className="mb-2 text-xl font-semibold tracking-tight">Invite unusable</h1>
          <p className="mb-6 text-sm text-muted-foreground">
            This invite has {probe.reason === "used" ? "already been used" : probe.reason}.
            Ask whoever sent it to generate a new one.
          </p>
          <Link href="/login" className="text-sm text-primary hover:underline">
            Go to sign in →
          </Link>
        </>
      ) : (
        <>
          <h1 className="mb-1 text-xl font-semibold tracking-tight">Accept invite</h1>
          <p className="mb-6 text-sm text-muted-foreground">
            Create your account to join this Homelab Control Center instance.
          </p>
          <AcceptInviteForm token={params.token} emailHint={probe.invite.emailHint} />
        </>
      )}
    </div>
  );
}
