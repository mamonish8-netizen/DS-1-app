import { useState } from "react";
import type { TelemetryHistoryPoint } from "../../aerocool-monitor/frontend/src/types/telemetry";

interface ThermalTrendChartProps {
  points: TelemetryHistoryPoint[];
  windowMinutes?: number;
}

export function ThermalTrendChart({ points, windowMinutes = 15 }: ThermalTrendChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 800;
  const height = 250;
  const pad = { top: 20, right: 16, bottom: 30, left: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const visiblePoints = points.slice(-75);

  if (visiblePoints.length < 2) {
    return (
      <div className="h-[240px] flex items-center justify-center rounded-lg border border-slate-800 bg-[#090d16] text-sm text-slate-400">
        Collecting live thermal telemetry samples...
      </div>
    );
  }

  const minTemp = 25;
  const maxTemp = 100;

  const xFor = (idx: number) => pad.left + (idx / Math.max(1, visiblePoints.length - 1)) * plotW;
  const yForTemp = (temp: number) =>
    pad.top + plotH - ((Math.max(minTemp, Math.min(maxTemp, temp)) - minTemp) / (maxTemp - minTemp)) * plotH;

  const cpuPolyline = visiblePoints
    .map((pt, idx) => `${xFor(idx).toFixed(1)},${yForTemp(pt.cpu_temp_c).toFixed(1)}`)
    .join(" ");

  const gpuPolyline = visiblePoints
    .map((pt, idx) => `${xFor(idx).toFixed(1)},${yForTemp(pt.gpu_temp_c).toFixed(1)}`)
    .join(" ");

  const cpuPolygon = `${pad.left.toFixed(1)},${(pad.top + plotH).toFixed(1)} ${cpuPolyline} ${xFor(visiblePoints.length - 1).toFixed(1)},${(pad.top + plotH).toFixed(1)}`;
  const gpuPolygon = `${pad.left.toFixed(1)},${(pad.top + plotH).toFixed(1)} ${gpuPolyline} ${xFor(visiblePoints.length - 1).toFixed(1)},${(pad.top + plotH).toFixed(1)}`;

  const gridTemps = [30, 50, 70, 90];
  const activePoint = hoverIndex !== null ? visiblePoints[hoverIndex] : visiblePoints[visiblePoints.length - 1];
  const activeX = hoverIndex !== null ? xFor(hoverIndex) : xFor(visiblePoints.length - 1);

  return (
    <div className="rounded-lg border border-slate-800 bg-[#090d16] p-4 sm:p-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-sm sm:text-base font-semibold text-white">
            Thermal Trajectory ({windowMinutes}m Window)
          </h2>
          <p className="text-xs text-slate-400">
            CPU & GPU die temperatures · Straight-segment real-time stream
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs font-mono-tabular">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 bg-[#F97316] shadow-[0_0_8px_#F97316]" />
            <span className="text-white">CPU {activePoint.cpu_temp_c.toFixed(1)}°C</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 bg-[#38BDF8] shadow-[0_0_8px_#38BDF8]" />
            <span className="text-white">GPU {activePoint.gpu_temp_c.toFixed(1)}°C</span>
          </div>
          <span className="text-slate-400">
            {activePoint.label} · {activePoint.fan_rpm} RPM
          </span>
        </div>
      </div>

      <div className="w-full overflow-hidden rounded border border-slate-800/80 bg-black p-2">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto max-h-[260px] cursor-crosshair select-none block"
          onMouseLeave={() => setHoverIndex(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = ((e.clientX - rect.left) / rect.width) * width;
            const ratio = Math.max(0, Math.min(1, (relX - pad.left) / plotW));
            const idx = Math.round(ratio * (visiblePoints.length - 1));
            setHoverIndex(idx);
          }}
        >
          <defs>
            <linearGradient id="cpuStraightFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#F97316" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#F97316" stopOpacity="0.0" />
            </linearGradient>
            <linearGradient id="gpuStraightFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {gridTemps.map((t) => {
            const y = yForTemp(t);
            return (
              <g key={t}>
                <line
                  x1={pad.left}
                  y1={y}
                  x2={width - pad.right}
                  y2={y}
                  stroke="#1e293b"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
                <text
                  x={pad.left - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-slate-500 font-mono-tabular text-[11px]"
                >
                  {t}°
                </text>
              </g>
            );
          })}

          <polygon points={gpuPolygon} fill="url(#gpuStraightFill)" />
          <polygon points={cpuPolygon} fill="url(#cpuStraightFill)" />

          <polyline
            points={gpuPolyline}
            fill="none"
            stroke="#38BDF8"
            strokeWidth="2.2"
            strokeLinejoin="miter"
            strokeLinecap="square"
            style={{ filter: "drop-shadow(0 0 5px rgba(56, 189, 248, 0.55))" }}
          />
          <polyline
            points={cpuPolyline}
            fill="none"
            stroke="#F97316"
            strokeWidth="2.2"
            strokeLinejoin="miter"
            strokeLinecap="square"
            style={{ filter: "drop-shadow(0 0 5px rgba(249, 115, 22, 0.55))" }}
          />

          {hoverIndex !== null && (
            <g>
              <line
                x1={activeX}
                y1={pad.top}
                x2={activeX}
                y2={pad.top + plotH}
                stroke="#64748b"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <rect
                x={activeX - 3.5}
                y={yForTemp(activePoint.cpu_temp_c) - 3.5}
                width="7"
                height="7"
                fill="#F97316"
                stroke="#ffffff"
                strokeWidth="1.2"
              />
              <rect
                x={activeX - 3.5}
                y={yForTemp(activePoint.gpu_temp_c) - 3.5}
                width="7"
                height="7"
                fill="#38BDF8"
                stroke="#ffffff"
                strokeWidth="1.2"
              />
            </g>
          )}

          <text x={pad.left} y={height - 8} textAnchor="start" className="fill-slate-500 font-mono-tabular text-[11px]">
            {visiblePoints[0]?.label}
          </text>
          <text x={width - pad.right} y={height - 8} textAnchor="end" className="fill-slate-500 font-mono-tabular text-[11px]">
            {visiblePoints[visiblePoints.length - 1]?.label}
          </text>
        </svg>
      </div>
    </div>
  );
}
