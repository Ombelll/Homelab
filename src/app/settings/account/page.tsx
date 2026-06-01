import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { getCurrentUser } from "@/lib/session";
import { ChangePasswordForm } from "./form";

export const dynamic = "force-dynamic";

// Account settings are available to ANY signed-in user (admin + viewer).
// The admin-only Settings panels live one level up at /settings.
export default async function AccountSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <>
      <PageHeader
        title="Account"
        description="Settings tied to your own user — visible to everyone, regardless of role."
      />

      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold">Profile</h2>
          <Row label="Email">{user.email}</Row>
          <Row label="Name">{user.name ?? "—"}</Row>
          <Row label="Role">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide">
              {user.role}
            </span>
          </Row>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-1 text-sm font-semibold">Change password</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Use a long, unique password. Other sessions you have open
            (phone, work laptop) will be signed out unless you opt out.
          </p>
          <ChangePasswordForm />
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}
