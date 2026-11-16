import { useState } from "react";
import { Wind, Zap } from "lucide-react";
import { useAeroCool } from "../aerocool-monitor/frontend/src/hooks/useAeroCool";
import { ProcessTgpScreen } from "./components/ProcessTgpScreen";
import { ProfileSymbol } from "./components/ProfileSymbol";
import { RadialGauge } from "./components/RadialGauge";
import { SpinningFanSvg } from "./components/SpinningFanSvg";
import { ThermalTrendChart } from "./components/ThermalTrendChart";
import { TunerScreen } from "./components/TunerScreen";

type ScreenTab = "overview" | "processes" | "tuner";

export default function App() {
  const {
    telemetry,
    history15m,
    tgpHistory,
    tunerState,
    profiles,
    loading,
    saving,
    error,
    clearError,
    updateFanCurve,
    updateClockOffsets,
    applyProfile,
    saveProfile,
    deleteProfile,
    resetTuner,
    resetTgpPeaks,
  } = useAeroCool();

  const [activeScreen, setActiveScreen] = useState<ScreenTab>("overview");

  const cpuTemp = telemetry?.cpu.temp_c ?? 0;
  const gpuTemp = telemetry?.gpu.temp_c ?? 0;
  const cpuFanRpm = telemetry?.cpu.fan_rpm ?? 900;
  const gpuFanRpm = telemetry?.gpu.fan_rpm ?? 950;
  const totalPowerW = (telemetry?.cpu.package_power_w ?? 0) + (telemetry?.gpu.power_w ?? 0);

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Clean 3-Zone Top Bar: Lightning Bolt Logo + Aero Cool System | 3 Screen Tabs | Primary Action */}
      <header className="border-b border-slate-800 bg-black/95 backdrop-blur-sm sticky top-0 z-30">
        <div className="mx-auto max-w-[1320px] px-3 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4 sm:gap-8">
          {/* Zone 1: Lightning Bolt Logo + Aero Cool System */}
          <a
            href="#overview"
            onClick={(e) => {
              e.preventDefault();
              setActiveScreen("overview");
            }}
            className="inline-flex items-center gap-2.5 text-base sm:text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            <span className="inline-flex h-8 w-8 items-center justify-center rounded border border-[#F97316]/60 bg-[#F97316]/15 glow-thermal">
              <Zap className="h-4 w-4 text-[#F97316] fill-[#F97316]" aria-hidden="true" />
            </span>
            <span>Aero Cool System</span>
          </a>

          {/* Zone 2: Single-line navigation links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
            {(
              [
                { id: "overview", label: "Thermal Overview" },
                { id: "processes", label: "Process & TGP" },
                { id: "tuner", label: "Curve & Clock Tuner" },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveScreen(item.id)}
                className={`py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  activeScreen === item.id
                    ? "border-[#38BDF8] text-white"
                    : "border-transparent text-slate-400 hover:text-white"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Zone 3: Single primary action */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() =>
                void applyProfile(
                  tunerState?.active_profile === "Extreme Cooling" ? "Balanced" : "Extreme Cooling"
                )
              }
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded bg-[#38BDF8] px-3 sm:px-4 py-2 text-xs font-semibold text-black hover:bg-[#7dd3fc] glow-cool transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Wind className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">
                {tunerState?.active_profile === "Extreme Cooling" ? "Restore Balanced" : "Max Cooling Boost"}
              </span>
              <span className="sm:hidden">Boost</span>
            </button>
          </div>
        </div>

        {/* Compact Mobile/Tablet Navigation Strip */}
        <div className="flex md:hidden border-t border-slate-800/80 px-3 py-1.5 gap-2 overflow-x-auto">
          {(
            [
              { id: "overview", label: "Thermal Overview" },
              { id: "processes", label: "Process & TGP" },
              { id: "tuner", label: "Curve & Clock Tuner" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveScreen(item.id)}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeScreen === item.id
                  ? "bg-[#38BDF8]/15 text-[#38BDF8] border border-[#38BDF8]/40"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      {/* Main Workspace Container fitted strictly to viewport bounds */}
      <main className="mx-auto max-w-[1320px] px-3 sm:px-6 lg:px-8 py-5 sm:py-6 space-y-5">
        {error && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[#F97316]/50 bg-[#F97316]/10 px-4 py-3 text-xs text-orange-200">
            <span>{error}</span>
            <button
              type="button"
              onClick={clearError}
              className="font-semibold underline whitespace-nowrap shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {loading && !telemetry ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((item) => (
              <div
                key={item}
                className="h-28 rounded-lg border border-slate-800 bg-[#090d16] animate-pulse"
              />
            ))}
          </div>
        ) : (
          <>
            {activeScreen === "overview" && telemetry && (
              <div className="space-y-5">
                {/* Hero Cooling Stage fitted cleanly inside its border lens on every device */}
                <section className="rounded-lg border border-slate-800 bg-[#090d16] p-4 sm:p-6 overflow-hidden">
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-center">
                    <div className="lg:col-span-7 space-y-3 min-w-0">
                      <p className="text-xs font-medium text-slate-400 truncate">
                        {telemetry.platform.cpu_model} · {telemetry.platform.gpu_model}
                      </p>
                      <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight text-white text-balance">
                        Active Loop Cooling & Thermal Equilibrium
                      </h1>

                      <div className="pt-1 flex flex-wrap items-center gap-5 sm:gap-7 font-mono-tabular">
                        <div>
                          <span className="text-[11px] text-slate-400 block">Combined Power</span>
                          <span className="text-lg sm:text-xl font-semibold text-[#F97316] text-glow-thermal">
                            {totalPowerW.toFixed(1)} W
                          </span>
                        </div>
                        <div>
                          <span className="text-[11px] text-slate-400 block">CPU Core Clock</span>
                          <span className="text-lg sm:text-xl font-semibold text-white">
                            {telemetry.cpu.clock_mhz.toFixed(0)} MHz
                          </span>
                        </div>
                        <div>
                          <span className="text-[11px] text-slate-400 block">GPU Core Clock</span>
                          <span className="text-lg sm:text-xl font-semibold text-[#38BDF8] text-glow-cool">
                            {telemetry.gpu.clock_mhz.toFixed(0)} MHz
                          </span>
                        </div>
                      </div>

                      {/* Tuning Profile Buttons with Unique Profile Symbols */}
                      <div className="pt-2 flex flex-wrap items-center gap-2">
                        {profiles.map((prof) => {
                          const active = tunerState?.active_profile === prof.name;
                          return (
                            <button
                              key={prof.name}
                              type="button"
                              onClick={() => void applyProfile(prof.name)}
                              disabled={saving}
                              className={`inline-flex items-center gap-2 rounded border px-3 py-2 text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
                                active
                                  ? "border-[#38BDF8] bg-[#38BDF8]/15 text-white glow-cool"
                                  : "border-slate-800 bg-black text-slate-300 hover:border-slate-600 hover:text-white"
                              }`}
                            >
                              <ProfileSymbol name={prof.name} className="h-3.5 w-3.5 shrink-0" />
                              <span>{prof.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Bounded Fan Rotor Frame that scales cleanly per device border */}
                    <div className="lg:col-span-5 flex items-center justify-center">
                      <div className="flex items-center gap-4 sm:gap-6 rounded-lg border border-slate-800 bg-black px-5 py-4 w-full sm:w-auto justify-center">
                        <SpinningFanSvg
                          rpm={cpuFanRpm}
                          accent={telemetry.thermal_state === "critical" ? "thermal" : "cool"}
                          className="w-24 h-24 sm:w-32 sm:h-32 shrink-0"
                        />
                        <div className="font-mono-tabular space-y-1.5 min-w-0">
                          <p className="text-xs text-slate-400">Primary Rotor</p>
                          <p className="text-2xl font-semibold text-[#38BDF8] text-glow-cool">
                            {cpuFanRpm} <span className="text-xs text-slate-400">RPM</span>
                          </p>
                          <p className="text-xs text-slate-400">
                            Duty {telemetry.cpu.fan_pct.toFixed(1)}%
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Primary Telemetry Gauges */}
                <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                  <RadialGauge
                    label="CPU Package Temp"
                    value={cpuTemp}
                    max={100}
                    unit="°C"
                    sublabel={`${telemetry.cpu.usage_pct.toFixed(1)}% load · ${telemetry.cpu.voltage_mv.toFixed(0)} mV`}
                    tone="thermal"
                  />
                  <RadialGauge
                    label="GPU Core Temp"
                    value={gpuTemp}
                    max={95}
                    unit="°C"
                    sublabel={`Hotspot ${telemetry.gpu.hotspot_c.toFixed(1)}°C · ${telemetry.gpu.usage_pct.toFixed(1)}% load`}
                    tone="thermal"
                  />
                  <RadialGauge
                    label="CPU Cooling Fan"
                    value={cpuFanRpm}
                    max={2800}
                    unit="RPM"
                    sublabel={`${telemetry.cpu.fan_pct.toFixed(1)}% duty cycle`}
                    tone="cool"
                  />
                  <RadialGauge
                    label="GPU Blower Fan"
                    value={gpuFanRpm}
                    max={3200}
                    unit="RPM"
                    sublabel={`${telemetry.gpu.fan_pct.toFixed(1)}% duty · ${telemetry.gpu.power_w.toFixed(1)}W / ${telemetry.gpu.tgp_limit_w.toFixed(0)}W`}
                    tone="cool"
                  />
                </section>

                {/* Dominant Straight-Line Live Trend Chart */}
                <ThermalTrendChart points={history15m} windowMinutes={15} />
              </div>
            )}

            {activeScreen === "processes" && telemetry && (
              <ProcessTgpScreen
                processes={telemetry.processes}
                tgpHistory={tgpHistory}
                saving={saving}
                onResetPeaks={resetTgpPeaks}
              />
            )}

            {activeScreen === "tuner" && (
              <TunerScreen
                tunerState={tunerState}
                profiles={profiles}
                saving={saving}
                onUpdateFanCurve={updateFanCurve}
                onUpdateClockOffsets={updateClockOffsets}
                onApplyProfile={applyProfile}
                onSaveProfile={saveProfile}
                onDeleteProfile={deleteProfile}
                onResetTuner={resetTuner}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
