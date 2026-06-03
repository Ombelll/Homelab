"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck, ShieldOff } from "lucide-react";

type Step = "idle" | "enrolling" | "codes";

export function TwoFactorPanel({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // enrollment state
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  // disable state
  const [disableCode, setDisableCode] = useState("");

  async function startSetup() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/2fa/setup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "setup failed");
      setSecret(data.secret);
      setQr(data.qr);
      setStep("enrolling");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/2fa/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret, code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "enable failed");
      setRecoveryCodes(data.recoveryCodes || []);
      setStep("codes");
      setCode("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/2fa/disable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: disableCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "disable failed");
      setDisableCode("");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Show recovery codes once after enabling.
  if (step === "codes") {
    return (
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2 text-success">
          <ShieldCheck className="h-4 w-4" /> Two-factor authentication is on.
        </div>
        <p className="text-xs text-muted-foreground">
          Save these recovery codes somewhere safe (e.g. Vaultwarden). Each works once if you
          lose your authenticator. They won&apos;t be shown again.
        </p>
        <ul className="grid grid-cols-2 gap-1 rounded-md border border-border bg-background/60 p-3 font-mono text-xs">
          {recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent"
        >
          Done
        </button>
      </div>
    );
  }

  if (enabled) {
    return (
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2 text-success">
          <ShieldCheck className="h-4 w-4" /> Two-factor authentication is <b>enabled</b>.
        </div>
        <p className="text-xs text-muted-foreground">
          To turn it off, enter a current 6-digit code (or a recovery code).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            placeholder="code"
            value={disableCode}
            onChange={(e) => setDisableCode(e.target.value)}
            className="w-40 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            onClick={disable}
            disabled={busy || disableCode.length < 6}
            className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/20 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
            Disable 2FA
          </button>
        </div>
        {error ? <div className="text-xs text-destructive">{error}</div> : null}
      </div>
    );
  }

  if (step === "enrolling") {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Scan this with an authenticator app (Google Authenticator, Aegis, 1Password…), or
          enter the secret manually. Then type the 6-digit code to confirm.
        </p>
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element -- inline data-URL QR, next/image adds nothing
          <img src={qr} alt="2FA QR code" className="h-44 w-44 rounded-md bg-white p-1" />
        ) : null}
        <div className="font-mono text-xs text-muted-foreground break-all">secret: {secret}</div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-40 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            onClick={enable}
            disabled={busy || code.length < 6}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Confirm & enable
          </button>
          <button
            type="button"
            onClick={() => { setStep("idle"); setError(null); }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
        {error ? <div className="text-xs text-destructive">{error}</div> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Add a time-based one-time code (TOTP) from an authenticator app as a second step at login.
      </p>
      <button
        type="button"
        onClick={startSetup}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
        Enable 2FA
      </button>
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
    </div>
  );
}
