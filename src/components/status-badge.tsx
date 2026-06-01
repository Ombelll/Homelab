import { cn } from "@/lib/utils";

type Tone = "success" | "warning" | "destructive" | "muted" | "info";

const toneClass: Record<Tone, string> = {
  success: "bg-success/15 text-success border-success/30",
  warning: "bg-warning/15 text-warning border-warning/30",
  destructive: "bg-destructive/15 text-destructive border-destructive/40",
  muted: "bg-muted text-muted-foreground border-border",
  info: "bg-primary/15 text-primary border-primary/30",
};

const statusToTone: Record<string, Tone> = {
  online: "success",
  running: "success",
  warning: "warning",
  critical: "destructive",
  offline: "muted",
  exited: "muted",
  paused: "warning",
  restarting: "warning",
  info: "info",
};

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const tone = statusToTone[status.toLowerCase()] ?? "muted";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        toneClass[tone],
        className,
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full", {
          "bg-success": tone === "success",
          "bg-warning": tone === "warning",
          "bg-destructive": tone === "destructive",
          "bg-muted-foreground": tone === "muted",
          "bg-primary": tone === "info",
        })}
      />
      {status}
    </span>
  );
}
