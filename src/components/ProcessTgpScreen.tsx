import { useMemo, useState } from "react";
import { RotateCcw, Search } from "lucide-react";
import type { ProcessMetric, TgpHistoryResponse } from "../../aerocool-monitor/frontend/src/types/telemetry";

interface ProcessTgpScreenProps {
  processes: ProcessMetric[];
  tgpHistory: TgpHistoryResponse | null;
  saving: boolean;
  onResetPeaks: () => Promise<void>;
}

type SortKey = "power" | "cpu" | "gpu" | "voltage";

export function ProcessTgpScreen({
  processes,
  tgpHistory,
  saving,
  onResetPeaks,
}: ProcessTgpScreenProps) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("power");

  const filteredProcesses = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? processes.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q))
      : [...processes];

    list.sort((a, b) => {
      if (sortBy === "cpu") return b.cpu_pct - a.cpu_pct;
      if (sortBy === "gpu") return b.gpu_pct - a.gpu_pct;
      if (sortBy === "voltage") return b.peak_tgp_voltage_mv - a.peak_tgp_voltage_mv;
      return b.estimated_power_w - a.estimated_power_w;
    });
    return list;
  }, [processes, query, sortBy]);

  const samples = tgpHistory?.samples ?? [];
  const summary = tgpHistory?.summary ?? {
    peak_total_power_w: 0,
    avg_total_power_w: 0,
    peak_gpu_voltage_mv: 0,
    peak_gpu_temp_c: 0,
    sample_count: 0,
  };

  const chartW = 760;
  const chartH = 160;
  const padX = 42;
  const padY = 16;
  const innerW = chartW - padX * 2;
  const innerH = chartH - padY * 2;
  const maxPowerScale = Math.max(120, summary.peak_total_power_w * 1.15);

  const powerPoints =
    samples.length >= 2
      ? samples
          .map((s, idx) => {
            const x = padX + (idx / Math.max(1, samples.length - 1)) * innerW;
            const y = padY + innerH - (Math.min(maxPowerScale, s.total_power_w) / maxPowerScale) * innerH;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : "";

  return (
    <div className="space-y-5">
      {/* KPI Summary Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="rounded-lg border border-slate-800 bg-[#090d16] p-3.5 sm:p-4 overflow-hidden">
          <p className="text-xs font-medium text-slate-400 truncate">Peak Total Package Power</p>
          <p className="mt-1.5 font-mono-tabular text-xl sm:text-2xl font-semibold text-[#F97316] text-glow-thermal">
            {summary.peak_total_power_w.toFixed(1)}
            <span className="ml-1 text-xs font-medium text-slate-400">W</span>
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-[#090d16] p-3.5 sm:p-4 overflow-hidden">
          <p className="text-xs font-medium text-slate-400 truncate">Average Package Draw</p>
          <p className="mt-1.5 font-mono-tabular text-xl sm:text-2xl font-semibold text-white">
            {summary.avg_total_power_w.toFixed(1)}
            <span className="ml-1 text-xs font-medium text-slate-400">W</span>
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-[#090d16] p-3.5 sm:p-4 overflow-hidden">
          <p className="text-xs font-medium text-slate-400 truncate">Peak GPU TGP Voltage</p>
          <p className="mt-1.5 font-mono-tabular text-xl sm:text-2xl font-semibold text-[#38BDF8] text-glow-cool">
            {summary.peak_gpu_voltage_mv.toFixed(1)}
            <span className="ml-1 text-xs font-medium text-slate-400">mV</span>
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-[#090d16] p-3.5 sm:p-4 overflow-hidden">
          <p className="text-xs font-medium text-slate-400 truncate">Peak GPU Junction Temp</p>
          <p className="mt-1.5 font-mono-tabular text-xl sm:text-2xl font-semibold text-white">
            {summary.peak_gpu_temp_c.toFixed(1)}
            <span className="ml-1 text-xs font-medium text-slate-400">°C</span>
          </p>
        </div>
      </div>

      {/* Historical Total Power Curve (Straight Lines) */}
      <div className="rounded-lg border border-slate-800 bg-[#090d16] p-4 sm:p-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-semibold text-white">
              Total Graphics & Package Power History
            </h2>
            <p className="text-xs text-slate-400">
              Combined CPU + GPU wattage ({summary.sample_count} samples)
            </p>
          </div>
          <button
            type="button"
            onClick={() => void onResetPeaks()}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded border border-slate-700 bg-black px-3 py-1.5 text-xs font-medium text-white hover:border-[#F97316] transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <RotateCcw className="h-3.5 w-3.5 text-[#F97316]" />
            Reset Peak Voltage History
          </button>
        </div>

        <div className="rounded border border-slate-800/80 bg-black p-2 overflow-hidden">
          {samples.length >= 2 ? (
            <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full h-36 sm:h-40 block">
              {[0.25, 0.5, 0.75, 1].map((frac) => {
                const y = padY + innerH - frac * innerH;
                return (
                  <g key={frac}>
                    <line
                      x1={padX}
                      y1={y}
                      x2={chartW - padX}
                      y2={y}
                      stroke="#1e293b"
                      strokeDasharray="4 4"
                    />
                    <text
                      x={padX - 6}
                      y={y + 4}
                      textAnchor="end"
                      className="fill-slate-500 font-mono-tabular text-[10px]"
                    >
                      {Math.round(maxPowerScale * frac)}W
                    </text>
                  </g>
                );
              })}
              <polyline
                points={powerPoints}
                fill="none"
                stroke="#F97316"
                strokeWidth="2.2"
                strokeLinejoin="miter"
                strokeLinecap="square"
                style={{ filter: "drop-shadow(0 0 5px rgba(249, 115, 22, 0.55))" }}
              />
            </svg>
          ) : (
            <div className="h-36 flex items-center justify-center text-xs text-slate-400">
              Accumulating 5-second TGP power snapshots...
            </div>
          )}
        </div>
      </div>

      {/* Live Process Attribution & Max TGP Voltage Table */}
      <div className="rounded-lg border border-slate-800 bg-[#090d16] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-semibold text-white">
              Active Process Power & Peak TGP Voltage
            </h2>
            <p className="text-xs text-slate-400">
              Per-process CPU%, GPU%, wattage attribution, and historical Max TGP Voltage
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
            <div className="relative flex-1 sm:flex-initial">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter process or PID..."
                aria-label="Filter process or PID"
                className="w-full sm:w-44 rounded border border-slate-700 bg-black pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-[#38BDF8] focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-1 rounded border border-slate-800 bg-black p-0.5">
              {(
                [
                  { id: "power", label: "Power" },
                  { id: "cpu", label: "CPU %" },
                  { id: "gpu", label: "GPU %" },
                  { id: "voltage", label: "Max TGP" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSortBy(tab.id)}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    sortBy === tab.id
                      ? "bg-[#38BDF8] text-black font-semibold"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-black/40">
                <th className="py-2.5 px-4">Process</th>
                <th className="py-2.5 px-3 text-right">PID</th>
                <th className="py-2.5 px-3 text-right">CPU</th>
                <th className="py-2.5 px-3 text-right">GPU</th>
                <th className="py-2.5 px-3 text-right hidden sm:table-cell">Memory</th>
                <th className="py-2.5 px-3 text-right">Est. Power</th>
                <th className="py-2.5 px-4 text-right">Max TGP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-xs sm:text-sm">
              {filteredProcesses.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-xs text-slate-400">
                    No active processes match your filter.
                  </td>
                </tr>
              ) : (
                filteredProcesses.map((proc) => (
                  <tr
                    key={`${proc.pid}-${proc.name}`}
                    className="hover:bg-[#111827] transition-colors"
                  >
                    <td className="py-2.5 px-4 font-medium text-white truncate max-w-[140px] sm:max-w-none">
                      {proc.name}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono-tabular text-xs text-slate-400">
                      {proc.pid}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono-tabular text-slate-300">
                      {proc.cpu_pct.toFixed(1)}%
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono-tabular text-[#38BDF8]">
                      {proc.gpu_pct.toFixed(1)}%
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono-tabular text-slate-400 hidden sm:table-cell">
                      {proc.memory_mb.toFixed(0)} MB
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono-tabular font-semibold text-[#F97316]">
                      {proc.estimated_power_w.toFixed(2)} W
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono-tabular font-medium text-white">
                      {proc.peak_tgp_voltage_mv.toFixed(1)} mV
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
