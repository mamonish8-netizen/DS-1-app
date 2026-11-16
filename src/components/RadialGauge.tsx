interface RadialGaugeProps {
  label: string;
  value: number;
  max: number;
  unit: string;
  sublabel: string;
  tone: "cool" | "thermal";
}

export function RadialGauge({ label, value, max, unit, sublabel, tone }: RadialGaugeProps) {
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const clampedRatio = Math.max(0, Math.min(1, value / Math.max(1, max)));
  const dashOffset = circumference * (1 - clampedRatio);
  const strokeHex = tone === "cool" ? "#38BDF8" : "#F97316";
  const glowClass = tone === "cool" ? "hover:border-[#38BDF8]/60" : "hover:border-[#F97316]/60";

  return (
    <div
      className={`flex items-center gap-3.5 rounded-lg border border-slate-800 bg-[#090d16] p-3.5 sm:p-4 overflow-hidden transition-colors ${glowClass}`}
    >
      <div className="relative h-20 w-20 sm:h-22 sm:w-22 shrink-0 flex items-center justify-center">
        <svg className="h-full w-full -rotate-90" viewBox="0 0 96 96" aria-hidden="true">
          <circle
            cx="48"
            cy="48"
            r={radius}
            fill="none"
            stroke="#1e293b"
            strokeWidth="5"
          />
          <circle
            cx="48"
            cy="48"
            r={radius}
            fill="none"
            stroke={strokeHex}
            strokeWidth="5"
            strokeLinecap="butt"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{
              transition: "stroke-dashoffset 180ms cubic-bezier(0.16, 1, 0.3, 1)",
              filter: `drop-shadow(0 0 6px ${strokeHex}88)`,
            }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono-tabular text-base sm:text-lg font-semibold text-white">
            {Number.isInteger(value) ? value : value.toFixed(1)}
          </span>
          <span className="font-mono-tabular text-[10px] text-slate-400">{unit}</span>
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-slate-400 truncate">{label}</p>
        <p className="mt-1 font-mono-tabular text-xl sm:text-2xl font-semibold text-white">
          {Number.isInteger(value) ? value : value.toFixed(1)}
          <span className="ml-1 text-xs font-medium text-slate-400">{unit}</span>
        </p>
        <p className="mt-1 font-mono-tabular text-[11px] sm:text-xs text-slate-400 truncate">{sublabel}</p>
      </div>
    </div>
  );
}
