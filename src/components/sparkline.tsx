import { cn } from "@/lib/utils";

/**
 * Tiny SVG sparkline — no chart library, no client-side runtime cost. Renders
 * a polyline over a 0..100 Y axis (percent metrics) and a soft area fill.
 */
export function Sparkline({
  values,
  width = 120,
  height = 32,
  tone = "primary",
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: "primary" | "success" | "warning" | "destructive";
  className?: string;
}) {
  if (!values || values.length < 2) {
    return (
      <div
        className={cn("flex items-center text-xs text-muted-foreground", className)}
        style={{ width, height }}
      >
        no data
      </div>
    );
  }

  const max = 100;
  const min = 0;
  const stepX = width / (values.length - 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / (max - min)) * height;
    return [x, y] as const;
  });

  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;

  const stroke = `var(--spark-${tone})`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      style={{
        // Map tones to CSS vars that resolve via Tailwind's HSL theme tokens.
        ["--spark-primary" as string]: "hsl(var(--primary))",
        ["--spark-success" as string]: "hsl(var(--success))",
        ["--spark-warning" as string]: "hsl(var(--warning))",
        ["--spark-destructive" as string]: "hsl(var(--destructive))",
      }}
      aria-hidden
    >
      <path d={area} fill={stroke} opacity={0.15} />
      <path d={line} stroke={stroke} strokeWidth={1.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
