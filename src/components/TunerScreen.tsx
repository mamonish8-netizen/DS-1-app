import { useEffect, useState } from "react";
import { Lock, Minus, Plus, RotateCcw, Save, Trash2, Unlock } from "lucide-react";
import type {
  ClockOffsets,
  FanCurvePoint,
  SaveProfileInput,
  TunerApplyInput,
  TunerProfile,
  TunerState,
} from "../../aerocool-monitor/frontend/src/types/telemetry";
import { ProfileSymbol } from "./ProfileSymbol";

interface TunerScreenProps {
  tunerState: TunerState | null;
  profiles: TunerProfile[];
  saving: boolean;
  onApplyTuner: (payload: TunerApplyInput) => Promise<TunerState | null>;
  onUpdateFanCurve: (points: FanCurvePoint[]) => Promise<TunerState | null>;
  onApplyProfile: (name: string) => Promise<TunerState | null>;
  onSaveProfile: (payload: SaveProfileInput) => Promise<TunerProfile | null>;
  onDeleteProfile: (name: string) => Promise<boolean>;
  onResetTuner: () => Promise<TunerState | null>;
}

export function TunerScreen({
  tunerState,
  profiles,
  saving,
  onApplyTuner,
  onUpdateFanCurve,
  onApplyProfile,
  onSaveProfile,
  onDeleteProfile,
  onResetTuner,
}: TunerScreenProps) {
  const [curveDraft, setCurveDraft] = useState<FanCurvePoint[]>([]);
  const [offsetsDraft, setOffsetsDraft] = useState<ClockOffsets>({
    cpu_core_mhz: 0,
    gpu_core_mhz: 0,
    gpu_mem_mhz: 0,
    power_limit_pct: 100,
    voltage_offset_mv: 0,
    manual_fan_override_pct: null,
  });
  const [newProfileName, setNewProfileName] = useState("");
  const [validationNotice, setValidationNotice] = useState<string | null>(null);

  const isLocked = Boolean(tunerState?.locked);

  useEffect(() => {
    if (tunerState) {
      setCurveDraft(tunerState.fan_curve.map((pt) => ({ ...pt })));
      setOffsetsDraft({ ...tunerState.clock_offsets });
    }
  }, [tunerState]);

  const validateCurveDraft = (points: FanCurvePoint[]): FanCurvePoint[] | null => {
    const ordered = [...points].sort((a, b) => a.temp_c - b.temp_c);
    if (ordered.length < 3 || ordered.length > 8) {
      setValidationNotice("Fan curve must contain between 3 and 8 breakpoints.");
      return null;
    }
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].temp_c <= ordered[i - 1].temp_c) {
        setValidationNotice("Temperature breakpoints must be strictly increasing.");
        return null;
      }
      if (ordered[i].fan_pct < ordered[i - 1].fan_pct) {
        setValidationNotice("Fan speed cannot decrease as temperature rises.");
        return null;
      }
    }
    for (const pt of ordered) {
      if (pt.temp_c >= 85 && pt.fan_pct < 70) {
        setValidationNotice(`Thermal safety rule: at ${pt.temp_c}°C (>= 85°C), fan duty must be at least 70%.`);
        return null;
      }
    }
    setValidationNotice(null);
    return ordered;
  };

  const handlePointChange = (index: number, field: "temp_c" | "fan_pct", rawVal: number) => {
    if (isLocked) return;
    setValidationNotice(null);
    setCurveDraft((prev) =>
      prev.map((pt, i) => {
        if (i !== index) return pt;
        return {
          ...pt,
          [field]: Math.round(rawVal),
        };
      })
    );
  };

  const handleAddPoint = () => {
    if (isLocked || curveDraft.length >= 8) return;
    const ordered = [...curveDraft].sort((a, b) => a.temp_c - b.temp_c);
    const last = ordered[ordered.length - 1] ?? { temp_c: 80, fan_pct: 80 };
    const nextTemp = Math.min(98, last.temp_c + 5);
    const nextPct = Math.min(100, Math.max(last.fan_pct, nextTemp >= 85 ? 85 : last.fan_pct + 5));
    setCurveDraft([...ordered, { temp_c: nextTemp, fan_pct: nextPct }]);
  };

  const handleRemovePoint = (index: number) => {
    if (isLocked || curveDraft.length <= 3) return;
    setCurveDraft((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSaveCurve = async () => {
    const validated = validateCurveDraft(curveDraft);
    if (!validated) return;
    await onUpdateFanCurve(validated);
  };

  const handleApplyAndLock = async () => {
    if (isLocked) {
      await onApplyTuner({ locked: false });
      return;
    }
    const validated = validateCurveDraft(curveDraft);
    if (!validated) return;
    await onApplyTuner({
      fan_curve: validated,
      clock_offsets: offsetsDraft,
      locked: true,
    });
  };

  const handleStepOffset = (
    key: Exclude<keyof ClockOffsets, "manual_fan_override_pct">,
    delta: number,
    min: number,
    max: number
  ) => {
    if (isLocked) return;
    setOffsetsDraft((prev) => ({
      ...prev,
      [key]: Math.max(min, Math.min(max, prev[key] + delta)),
    }));
  };

  const handleSaveNewProfile = async () => {
    const trimmed = newProfileName.trim();
    if (trimmed.length < 2) {
      setValidationNotice("Enter a profile name of at least 2 characters.");
      return;
    }
    const validated = validateCurveDraft(curveDraft);
    if (!validated) return;
    const saved = await onSaveProfile({
      name: trimmed,
      description: `Custom curve (${offsetsDraft.power_limit_pct}% TGP, ${offsetsDraft.cpu_core_mhz >= 0 ? "+" : ""}${offsetsDraft.cpu_core_mhz} MHz CPU)`,
      fan_curve: validated,
      clock_offsets: offsetsDraft,
    });
    if (saved) {
      setNewProfileName("");
    }
  };

  const svgW = 540;
  const svgH = 230;
  const pad = { top: 20, right: 20, bottom: 30, left: 40 };
  const plotW = svgW - pad.left - pad.right;
  const plotH = svgH - pad.top - pad.bottom;

  const xForTemp = (temp: number) => pad.left + ((Math.max(20, Math.min(100, temp)) - 20) / 80) * plotW;
  const yForPct = (pct: number) => pad.top + plotH - (Math.max(0, Math.min(100, pct)) / 100) * plotH;

  const orderedCurve = [...curveDraft].sort((a, b) => a.temp_c - b.temp_c);
  const polylinePts = orderedCurve
    .map((pt) => `${xForTemp(pt.temp_c).toFixed(1)},${yForPct(pt.fan_pct).toFixed(1)}`)
    .join(" ");

  return (
    <div className="space-y-5">
      {/* Tuning Profiles Selector + Apply & Lock + Reset to Defaults */}
      <div className="rounded-lg border border-slate-800 bg-[#090d16] p-4 sm:p-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-semibold text-white">
              Cooling & Tuning Profiles
            </h2>
            <p className="text-xs text-slate-400">
              Select a power & airflow mode or lock custom hardware offsets
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleApplyAndLock()}
              disabled={saving}
              className={`inline-flex items-center gap-1.5 rounded px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 whitespace-nowrap shrink-0 ${
                isLocked
                  ? "bg-white text-black hover:bg-slate-200"
                  : "bg-[#F97316] text-black hover:bg-[#fb923c] glow-thermal"
              }`}
            >
              {isLocked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
              {isLocked ? "Unlock Controls" : "Apply & Lock"}
            </button>

            <button
              type="button"
              onClick={() => void onResetTuner()}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded border border-slate-700 bg-black px-3 py-1.5 text-xs font-medium text-white hover:border-[#38BDF8] transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3.5 w-3.5 text-[#38BDF8]" />
              Reset to Defaults
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {profiles.map((prof) => {
            const isActive = tunerState?.active_profile === prof.name;
            return (
              <div
                key={prof.name}
                className={`rounded-lg border p-3.5 transition-all overflow-hidden ${
                  isActive
                    ? "border-[#38BDF8] bg-[#38BDF8]/12 glow-cool"
                    : "border-slate-800 bg-black/70 hover:border-slate-600"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => void onApplyProfile(prof.name)}
                    disabled={saving || isLocked}
                    className="text-left flex-1 min-w-0 disabled:opacity-60"
                  >
                    <div className="flex items-center gap-2">
                      <ProfileSymbol name={prof.name} className="h-4 w-4 shrink-0" />
                      <p className="text-sm font-semibold text-white truncate">{prof.name}</p>
                    </div>
                    <p className="mt-1.5 text-xs text-slate-400 line-clamp-2">{prof.description}</p>
                  </button>
                  {!prof.is_builtin && (
                    <button
                      type="button"
                      onClick={() => void onDeleteProfile(prof.name)}
                      disabled={isLocked}
                      aria-label={`Delete profile ${prof.name}`}
                      className="p-1 text-slate-500 hover:text-[#F97316] transition-colors shrink-0 disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {validationNotice && (
        <div className="rounded-lg border border-[#F97316]/60 bg-[#F97316]/10 px-4 py-3 text-xs font-medium text-orange-200">
          {validationNotice}
        </div>
      )}

      {/* Main 2-Column Split: Fan Curve Editor + Clock Boost Steppers */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left: Straight-Line Fan Curve Editor */}
        <div className="lg:col-span-6 rounded-lg border border-slate-800 bg-[#090d16] p-4 sm:p-5 space-y-4 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-semibold text-white">
                {curveDraft.length}-Point Thermal Fan Curve
              </h3>
              <p className="text-xs text-slate-400">
                Safety floor enforces &ge;70% fan duty at &ge;85°C
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleAddPoint}
                disabled={saving || isLocked || curveDraft.length >= 8}
                className="rounded border border-slate-700 bg-black px-2.5 py-1.5 text-xs font-medium text-white hover:border-[#38BDF8] disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                + Point
              </button>
              <button
                type="button"
                onClick={() => void handleSaveCurve()}
                disabled={saving || isLocked}
                className="inline-flex items-center gap-1.5 rounded bg-[#38BDF8] px-3.5 py-2 text-xs font-semibold text-black hover:bg-[#7dd3fc] glow-cool transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Save className="h-3.5 w-3.5" />
                Save Curve
              </button>
            </div>
          </div>

          <div className="rounded border border-slate-800/80 bg-black p-2 overflow-hidden">
            <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full h-auto block">
              {[25, 50, 75, 100].map((pct) => (
                <g key={pct}>
                  <line
                    x1={pad.left}
                    y1={yForPct(pct)}
                    x2={svgW - pad.right}
                    y2={yForPct(pct)}
                    stroke="#1e293b"
                    strokeDasharray="4 4"
                  />
                  <text
                    x={pad.left - 8}
                    y={yForPct(pct) + 4}
                    textAnchor="end"
                    className="fill-slate-500 font-mono-tabular text-[10px]"
                  >
                    {pct}%
                  </text>
                </g>
              ))}

              {[30, 50, 70, 90].map((temp) => (
                <text
                  key={temp}
                  x={xForTemp(temp)}
                  y={svgH - 8}
                  textAnchor="middle"
                  className="fill-slate-500 font-mono-tabular text-[10px]"
                >
                  {temp}°C
                </text>
              ))}

              {polylinePts && (
                <polyline
                  points={polylinePts}
                  fill="none"
                  stroke="#38BDF8"
                  strokeWidth="2.4"
                  strokeLinejoin="miter"
                  strokeLinecap="square"
                  style={{ filter: "drop-shadow(0 0 5px rgba(56, 189, 248, 0.55))" }}
                />
              )}

              {orderedCurve.map((pt, idx) => (
                <g key={`${idx}-${pt.temp_c}`}>
                  <rect
                    x={xForTemp(pt.temp_c) - 4.5}
                    y={yForPct(pt.fan_pct) - 4.5}
                    width="9"
                    height="9"
                    fill="#000000"
                    stroke="#38BDF8"
                    strokeWidth="2"
                  />
                  <text
                    x={xForTemp(pt.temp_c)}
                    y={yForPct(pt.fan_pct) - 10}
                    textAnchor="middle"
                    className="fill-white font-mono-tabular text-[10px]"
                  >
                    {pt.fan_pct}%
                  </text>
                </g>
              ))}
            </svg>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5 sm:gap-2">
            {curveDraft.map((pt, idx) => (
              <div
                key={idx}
                className="rounded border border-slate-800 bg-black p-1.5 sm:p-2 space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono-tabular text-slate-400">P{idx + 1}</span>
                  {curveDraft.length > 3 && !isLocked && (
                    <button
                      type="button"
                      onClick={() => handleRemovePoint(idx)}
                      aria-label={`Remove point ${idx + 1}`}
                      className="text-[10px] text-slate-500 hover:text-[#F97316]"
                    >
                      ×
                    </button>
                  )}
                </div>
                <label className="block text-[10px] sm:text-[11px] font-medium text-slate-400">
                  °C
                  <input
                    type="number"
                    min={20}
                    max={100}
                    disabled={isLocked}
                    value={pt.temp_c}
                    onChange={(e) => handlePointChange(idx, "temp_c", Number(e.target.value))}
                    className="mt-0.5 w-full rounded border border-slate-700 bg-[#090d16] px-1.5 py-1 font-mono-tabular text-xs text-white focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
                  />
                </label>
                <label className="block text-[10px] sm:text-[11px] font-medium text-slate-400">
                  Duty %
                  <input
                    type="number"
                    min={0}
                    max={100}
                    disabled={isLocked}
                    value={pt.fan_pct}
                    onChange={(e) => handlePointChange(idx, "fan_pct", Number(e.target.value))}
                    className="mt-0.5 w-full rounded border border-slate-700 bg-[#090d16] px-1.5 py-1 font-mono-tabular text-xs text-white focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
                  />
                </label>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Clock Boost Steppers + Manual Fan Sliders */}
        <div className="lg:col-span-6 rounded-lg border border-slate-800 bg-[#090d16] p-4 sm:p-5 space-y-4 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-semibold text-white">
                Clock Boost Steppers & Manual Fan Override
              </h3>
              <p className="text-xs text-slate-400">
                Clamped within safe thermal hardware limits
              </p>
            </div>
            <button
              type="button"
              onClick={() => void onApplyTuner({ clock_offsets: offsetsDraft, locked: isLocked })}
              disabled={saving || isLocked}
              className="inline-flex items-center gap-1.5 rounded border border-[#F97316] bg-[#F97316]/15 px-3.5 py-2 text-xs font-semibold text-[#F97316] hover:bg-[#F97316] hover:text-black transition-colors disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Save className="h-3.5 w-3.5" />
              Apply Offsets
            </button>
          </div>

          <div className="space-y-3.5">
            {[
              {
                key: "cpu_core_mhz" as const,
                label: "CPU Core Clock Offset",
                min: -500,
                max: 300,
                step: 25,
                unit: "MHz",
                tone: "thermal",
              },
              {
                key: "gpu_core_mhz" as const,
                label: "GPU Core Clock Offset",
                min: -300,
                max: 225,
                step: 15,
                unit: "MHz",
                tone: "thermal",
              },
              {
                key: "gpu_mem_mhz" as const,
                label: "GPU Memory Offset",
                min: -500,
                max: 1000,
                step: 50,
                unit: "MHz",
                tone: "cool",
              },
              {
                key: "power_limit_pct" as const,
                label: "Board Power Limit (TGP)",
                min: 50,
                max: 115,
                step: 1,
                unit: "%",
                tone: "thermal",
              },
              {
                key: "voltage_offset_mv" as const,
                label: "Core Voltage Offset",
                min: -120,
                max: 50,
                step: 5,
                unit: "mV",
                tone: "thermal",
              },
            ].map((slider) => {
              const val = offsetsDraft[slider.key];
              const signed = slider.key !== "power_limit_pct" && val > 0 ? `+${val}` : `${val}`;
              return (
                <div key={slider.key} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-300 truncate">{slider.label}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={isLocked || val <= slider.min}
                        onClick={() => handleStepOffset(slider.key, -slider.step, slider.min, slider.max)}
                        aria-label={`Decrease ${slider.label}`}
                        className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-black text-slate-300 hover:border-[#38BDF8] hover:text-white disabled:opacity-40"
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                      <span className="w-20 text-center font-mono-tabular font-semibold text-white">
                        {signed} {slider.unit}
                      </span>
                      <button
                        type="button"
                        disabled={isLocked || val >= slider.max}
                        onClick={() => handleStepOffset(slider.key, slider.step, slider.min, slider.max)}
                        aria-label={`Increase ${slider.label}`}
                        className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-black text-slate-300 hover:border-[#F97316] hover:text-white disabled:opacity-40"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  <input
                    type="range"
                    min={slider.min}
                    max={slider.max}
                    step={slider.step}
                    disabled={isLocked}
                    value={val}
                    onChange={(e) =>
                      setOffsetsDraft((prev) => ({
                        ...prev,
                        [slider.key]: Number(e.target.value),
                      }))
                    }
                    className={`w-full h-1.5 rounded cursor-pointer disabled:opacity-50 ${
                      slider.tone === "cool" ? "accent-[#38BDF8]" : "accent-[#F97316]"
                    }`}
                  />
                </div>
              );
            })}

            <div className="pt-2 border-t border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-300">
                  <input
                    type="checkbox"
                    disabled={isLocked}
                    checked={offsetsDraft.manual_fan_override_pct !== null}
                    onChange={(e) =>
                      setOffsetsDraft((prev) => ({
                        ...prev,
                        manual_fan_override_pct: e.target.checked ? 75 : null,
                      }))
                    }
                    className="rounded border-slate-700 accent-[#38BDF8]"
                  />
                  Manual Fixed Fan Speed Override
                </label>
                <span className="font-mono-tabular text-xs font-semibold text-[#38BDF8]">
                  {offsetsDraft.manual_fan_override_pct !== null
                    ? `${offsetsDraft.manual_fan_override_pct}% Fixed`
                    : "Auto Curve"}
                </span>
              </div>
              {offsetsDraft.manual_fan_override_pct !== null && (
                <input
                  type="range"
                  min={20}
                  max={100}
                  step={5}
                  disabled={isLocked}
                  value={offsetsDraft.manual_fan_override_pct}
                  onChange={(e) =>
                    setOffsetsDraft((prev) => ({
                      ...prev,
                      manual_fan_override_pct: Number(e.target.value),
                    }))
                  }
                  className="w-full h-1.5 rounded cursor-pointer accent-[#38BDF8] disabled:opacity-50"
                />
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800 flex items-center gap-2">
            <input
              type="text"
              value={newProfileName}
              disabled={isLocked}
              onChange={(e) => setNewProfileName(e.target.value)}
              placeholder="Save current tune as profile..."
              className="flex-1 min-w-0 rounded border border-slate-700 bg-black px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void handleSaveNewProfile()}
              disabled={saving || isLocked}
              className="rounded border border-slate-600 bg-white px-3.5 py-2 text-xs font-semibold text-black hover:bg-slate-200 transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              Save Profile
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
