import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  tone?: "default" | "success" | "warning" | "destructive";
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        {Icon ? (
          <Icon
            className={cn("h-4 w-4 text-muted-foreground", {
              "text-success": tone === "success",
              "text-warning": tone === "warning",
              "text-destructive": tone === "destructive",
            })}
          />
        ) : null}
      </div>
      <div
        className={cn("mt-2 text-2xl font-semibold tabular-nums", {
          "text-success": tone === "success",
          "text-warning": tone === "warning",
          "text-destructive": tone === "destructive",
        })}
      >
        {value}
      </div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function ProgressBar({ value, tone }: { value: number; tone?: "success" | "warning" | "destructive" }) {
  const clamped = Math.max(0, Math.min(100, value));
  const color =
    tone ??
    (clamped >= 90 ? "destructive" : clamped >= 75 ? "warning" : "success");
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full transition-all", {
          "bg-success": color === "success",
          "bg-warning": color === "warning",
          "bg-destructive": color === "destructive",
        })}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
