import express, { type Request, type Response } from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";

import type {
  ClockOffsets,
  FanCurvePoint,
  ProcessMetric,
  ProcessTgpPeakRow,
  TelemetryFrame,
  TelemetryHistoryPoint,
  TgpSampleRow,
  ThermalSafetyLimits,
  TunerProfile,
  TunerState,
} from "./aerocool-monitor/frontend/src/types/telemetry";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const POLL_MS = 1000;
const MAX_BUFFER_POINTS = 900;

const SAFETY_LIMITS: ThermalSafetyLimits = {
  cpu_elevated_c: 75,
  cpu_critical_c: 90,
  gpu_elevated_c: 74,
  gpu_critical_c: 86,
  min_fan_curve_points: 3,
  max_fan_curve_points: 8,
  high_temp_threshold_c: 85,
  high_temp_min_fan_pct: 70,
  cpu_core_offset_min_mhz: -500,
  cpu_core_offset_max_mhz: 300,
  gpu_core_offset_min_mhz: -300,
  gpu_core_offset_max_mhz: 225,
  gpu_mem_offset_min_mhz: -500,
  gpu_mem_offset_max_mhz: 1000,
  power_limit_min_pct: 50,
  power_limit_max_pct: 115,
  voltage_offset_min_mv: -120,
  voltage_offset_max_mv: 50,
  manual_fan_min_pct: 20,
  manual_fan_max_pct: 100,
};

const BUILTIN_PROFILES: TunerProfile[] = [
  {
    name: "Silent",
    description: "Low acoustic footprint with relaxed fan ramp and conservative power target.",
    is_builtin: true,
    fan_curve: [
      { temp_c: 30, fan_pct: 22 },
      { temp_c: 50, fan_pct: 32 },
      { temp_c: 65, fan_pct: 48 },
      { temp_c: 78, fan_pct: 68 },
      { temp_c: 88, fan_pct: 85 },
    ],
    clock_offsets: {
      cpu_core_mhz: -100,
      gpu_core_mhz: -75,
      gpu_mem_mhz: 0,
      power_limit_pct: 85,
      voltage_offset_mv: -35,
      manual_fan_override_pct: null,
    },
    updated_at: new Date().toISOString(),
  },
  {
    name: "Balanced",
    description: "Factory thermal equilibrium across daily workloads and gaming.",
    is_builtin: true,
    fan_curve: [
      { temp_c: 30, fan_pct: 30 },
      { temp_c: 48, fan_pct: 42 },
      { temp_c: 65, fan_pct: 60 },
      { temp_c: 78, fan_pct: 78 },
      { temp_c: 88, fan_pct: 95 },
    ],
    clock_offsets: {
      cpu_core_mhz: 0,
      gpu_core_mhz: 0,
      gpu_mem_mhz: 0,
      power_limit_pct: 100,
      voltage_offset_mv: 0,
      manual_fan_override_pct: null,
    },
    updated_at: new Date().toISOString(),
  },
  {
    name: "Performance",
    description: "Aggressive boost clocks with proactive mid-band airflow curve.",
    is_builtin: true,
    fan_curve: [
      { temp_c: 30, fan_pct: 40 },
      { temp_c: 45, fan_pct: 55 },
      { temp_c: 60, fan_pct: 72 },
      { temp_c: 74, fan_pct: 88 },
      { temp_c: 85, fan_pct: 100 },
    ],
    clock_offsets: {
      cpu_core_mhz: 125,
      gpu_core_mhz: 110,
      gpu_mem_mhz: 350,
      power_limit_pct: 108,
      voltage_offset_mv: -20,
      manual_fan_override_pct: null,
    },
    updated_at: new Date().toISOString(),
  },
  {
    name: "Extreme Cooling",
    description: "Maximum heat dissipation for sustained workstation or benchmark loads.",
    is_builtin: true,
    fan_curve: [
      { temp_c: 30, fan_pct: 65 },
      { temp_c: 45, fan_pct: 78 },
      { temp_c: 60, fan_pct: 90 },
      { temp_c: 75, fan_pct: 100 },
      { temp_c: 85, fan_pct: 100 },
    ],
    clock_offsets: {
      cpu_core_mhz: 200,
      gpu_core_mhz: 150,
      gpu_mem_mhz: 500,
      power_limit_pct: 115,
      voltage_offset_mv: 15,
      manual_fan_override_pct: null,
    },
    updated_at: new Date().toISOString(),
  },
];

// Runtime state
const profilesMap = new Map<string, TunerProfile>(BUILTIN_PROFILES.map((p) => [p.name, structuredClone(p)]));
let activeTuner: TunerState = {
  active_profile: "Balanced",
  fan_curve: structuredClone(BUILTIN_PROFILES[1].fan_curve),
  clock_offsets: structuredClone(BUILTIN_PROFILES[1].clock_offsets),
  locked: false,
  updated_at: new Date().toISOString(),
  hardware_apply_status: "Active in thermal telemetry loop",
  safety_limits: SAFETY_LIMITS,
};

const historyBuffer: TelemetryHistoryPoint[] = [];
const tgpSamples: TgpSampleRow[] = [];
const processPeaks = new Map<string, ProcessTgpPeakRow>();

let prevCpuTimes = os.cpus().map((c) => ({ ...c.times }));
let simCpuTemp = 47.2;
let simGpuTemp = 44.5;
let simCpuFanPct = 40.0;
let simGpuFanPct = 38.0;
const startEpoch = Date.now();
let latestFrame: TelemetryFrame | null = null;

function interpolateFanPct(tempC: number, curve: FanCurvePoint[], overridePct: number | null): number {
  if (overridePct !== null && overridePct !== undefined) {
    return Math.max(0, Math.min(100, overridePct));
  }
  if (!curve.length) return 45;
  const ordered = [...curve].sort((a, b) => a.temp_c - b.temp_c);
  if (tempC <= ordered[0].temp_c) return ordered[0].fan_pct;
  if (tempC >= ordered[ordered.length - 1].temp_c) return ordered[ordered.length - 1].fan_pct;

  for (let i = 0; i < ordered.length - 1; i++) {
    const p0 = ordered[i];
    const p1 = ordered[i + 1];
    if (tempC >= p0.temp_c && tempC <= p1.temp_c) {
      const span = Math.max(1, p1.temp_c - p0.temp_c);
      const ratio = (tempC - p0.temp_c) / span;
      return Number((p0.fan_pct + ratio * (p1.fan_pct - p0.fan_pct)).toFixed(1));
    }
  }
  return ordered[ordered.length - 1].fan_pct;
}

function measureRealCpuUsagePct(): number {
  const current = os.cpus().map((c) => ({ ...c.times }));
  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < current.length; i++) {
    const prev = prevCpuTimes[i] ?? current[i];
    const cur = current[i];
    const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
    const curTotal = cur.user + cur.nice + cur.sys + cur.idle + cur.irq;
    idleDelta += Math.max(0, cur.idle - prev.idle);
    totalDelta += Math.max(0, curTotal - prevTotal);
  }
  prevCpuTimes = current;
  if (totalDelta <= 0) return 18.4;
  return Number(Math.max(1.5, Math.min(99.5, ((totalDelta - idleDelta) / totalDelta) * 100)).toFixed(1));
}

function readLinuxThermalZone(): number | null {
  try {
    const thermalRoot = "/sys/class/thermal";
    if (!fs.existsSync(thermalRoot)) return null;
    const entries = fs.readdirSync(thermalRoot).filter((d) => d.startsWith("thermal_zone"));
    for (const entry of entries) {
      const tempRaw = fs.readFileSync(path.join(thermalRoot, entry, "temp"), "utf8").trim();
      const milliC = Number(tempRaw);
      if (Number.isFinite(milliC) && milliC > 5000 && milliC < 125000) {
        return Number((milliC / 1000).toFixed(1));
      }
    }
  } catch {
    return null;
  }
  return null;
}

function validateFanCurve(points: FanCurvePoint[]): FanCurvePoint[] {
  if (
    !Array.isArray(points) ||
    points.length < SAFETY_LIMITS.min_fan_curve_points ||
    points.length > SAFETY_LIMITS.max_fan_curve_points
  ) {
    throw new Error(
      `Fan curve must contain between ${SAFETY_LIMITS.min_fan_curve_points} and ${SAFETY_LIMITS.max_fan_curve_points} points.`
    );
  }
  const ordered = [...points]
    .map((p) => ({
      temp_c: Math.round(Number(p.temp_c)),
      fan_pct: Math.round(Number(p.fan_pct)),
    }))
    .sort((a, b) => a.temp_c - b.temp_c);

  for (let i = 0; i < ordered.length; i++) {
    const pt = ordered[i];
    if (pt.temp_c < 20 || pt.temp_c > 100 || pt.fan_pct < 0 || pt.fan_pct > 100) {
      throw new Error("Fan curve points must be within 20–100°C and 0–100% duty.");
    }
    if (i > 0) {
      if (pt.temp_c <= ordered[i - 1].temp_c) {
        throw new Error("Fan curve temperature breakpoints must be strictly increasing.");
      }
      if (pt.fan_pct < ordered[i - 1].fan_pct) {
        throw new Error("Fan duty % cannot decrease as temperature rises.");
      }
    }
    if (pt.temp_c >= SAFETY_LIMITS.high_temp_threshold_c && pt.fan_pct < SAFETY_LIMITS.high_temp_min_fan_pct) {
      throw new Error(
        `Thermal safety rule: at ${pt.temp_c}°C (>= ${SAFETY_LIMITS.high_temp_threshold_c}°C), fan speed must be at least ${SAFETY_LIMITS.high_temp_min_fan_pct}%.`
      );
    }
  }
  return ordered;
}

function clampClockOffsets(input: Partial<ClockOffsets>): ClockOffsets {
  const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(val)));
  const overrideRaw = input.manual_fan_override_pct;
  const manualOverride =
    overrideRaw === null || overrideRaw === undefined
      ? null
      : clamp(Number(overrideRaw), SAFETY_LIMITS.manual_fan_min_pct, SAFETY_LIMITS.manual_fan_max_pct);

  return {
    cpu_core_mhz: clamp(
      Number(input.cpu_core_mhz ?? 0),
      SAFETY_LIMITS.cpu_core_offset_min_mhz,
      SAFETY_LIMITS.cpu_core_offset_max_mhz
    ),
    gpu_core_mhz: clamp(
      Number(input.gpu_core_mhz ?? 0),
      SAFETY_LIMITS.gpu_core_offset_min_mhz,
      SAFETY_LIMITS.gpu_core_offset_max_mhz
    ),
    gpu_mem_mhz: clamp(
      Number(input.gpu_mem_mhz ?? 0),
      SAFETY_LIMITS.gpu_mem_offset_min_mhz,
      SAFETY_LIMITS.gpu_mem_offset_max_mhz
    ),
    power_limit_pct: clamp(
      Number(input.power_limit_pct ?? 100),
      SAFETY_LIMITS.power_limit_min_pct,
      SAFETY_LIMITS.power_limit_max_pct
    ),
    voltage_offset_mv: clamp(
      Number(input.voltage_offset_mv ?? 0),
      SAFETY_LIMITS.voltage_offset_min_mv,
      SAFETY_LIMITS.voltage_offset_max_mv
    ),
    manual_fan_override_pct: manualOverride,
  };
}

let simCpuLoad = 36.0;
let simGpuLoad = 42.0;

function getProfileDynamics(profileName: string, offsets: ClockOffsets) {
  const powerScale = Math.max(0.5, Math.min(1.3, offsets.power_limit_pct / 100));
  switch (profileName) {
    case "Silent":
      return {
        cpuMin: 10,
        cpuMax: 46,
        gpuMin: 10,
        gpuMax: 44,
        stepScale: 16,
        spikeChance: 0.16,
        spikeAmplitude: 18,
        coolingGain: 13,
        powerScale,
      };
    case "Performance":
      return {
        cpuMin: 30,
        cpuMax: 94,
        gpuMin: 34,
        gpuMax: 96,
        stepScale: 28,
        spikeChance: 0.34,
        spikeAmplitude: 32,
        coolingGain: 15,
        powerScale,
      };
    case "Extreme Cooling":
      return {
        cpuMin: 36,
        cpuMax: 96,
        gpuMin: 40,
        gpuMax: 98,
        stepScale: 30,
        spikeChance: 0.32,
        spikeAmplitude: 34,
        coolingGain: 24,
        powerScale,
      };
    case "Balanced":
    default: {
      const customIntensity = (offsets.power_limit_pct - 50) / 65;
      const isBalanced = profileName === "Balanced";
      const intensity = isBalanced ? 0.68 : Math.max(0.25, Math.min(1.15, customIntensity));
      return {
        cpuMin: Math.round(14 + intensity * 14),
        cpuMax: Math.round(54 + intensity * 38),
        gpuMin: Math.round(14 + intensity * 16),
        gpuMax: Math.round(56 + intensity * 38),
        stepScale: Math.round(18 + intensity * 12),
        spikeChance: 0.24,
        spikeAmplitude: Math.round(18 + intensity * 14),
        coolingGain: 16,
        powerScale,
      };
    }
  }
}

function sampleTelemetryFrame(persistSnapshot: boolean): TelemetryFrame {
  const now = new Date();
  const epochMs = now.getTime();
  const elapsedSec = (epochMs - startEpoch) / 1000;

  const cpus = os.cpus();
  const coreCount = cpus.length || 8;
  const cpuModel = cpus[0]?.model?.trim() || "Workstation Multi-Core CPU";
  const baseClockMhz = cpus[0]?.speed && cpus[0].speed > 100 ? cpus[0].speed : 3850;
  const hostCpuUsage = measureRealCpuUsagePct();

  const offsets = activeTuner.clock_offsets;
  const dyn = getProfileDynamics(activeTuner.active_profile, offsets);
  const sources: string[] = ["os.cpus"];

  // Stochastic random loop coupled directly to the active power/tuning profile
  const cpuBurst = Math.random() < dyn.spikeChance ? (Math.random() > 0.45 ? dyn.spikeAmplitude : -dyn.spikeAmplitude * 0.85) : 0;
  const gpuBurst = Math.random() < dyn.spikeChance ? (Math.random() > 0.45 ? dyn.spikeAmplitude : -dyn.spikeAmplitude * 0.85) : 0;
  simCpuLoad = Math.max(
    dyn.cpuMin,
    Math.min(dyn.cpuMax, simCpuLoad + (Math.random() - 0.5) * dyn.stepScale + cpuBurst)
  );
  simGpuLoad = Math.max(
    dyn.gpuMin,
    Math.min(dyn.gpuMax, simGpuLoad + (Math.random() - 0.5) * dyn.stepScale + gpuBurst)
  );
  const cpuUsage = Number(Math.max(dyn.cpuMin, Math.min(99.5, simCpuLoad * 0.85 + hostCpuUsage * 0.15)).toFixed(1));

  const linuxTemp = readLinuxThermalZone();
  let cpuTemp: number;
  if (linuxTemp !== null) {
    sources.push("sysfs.thermal_zone");
    cpuTemp = linuxTemp;
  } else {
    sources.push("smart_simulation_fallback");
    const heatIn =
      26.0 +
      0.54 * cpuUsage * dyn.powerScale +
      Math.max(0, offsets.cpu_core_mhz) * 0.03 +
      offsets.voltage_offset_mv * 0.08 +
      (Math.random() - 0.5) * 4.5;
    const cooling = (simCpuFanPct / 100) * dyn.coolingGain;
    const targetTemp = Math.max(32, Math.min(95, heatIn - cooling * 0.52));
    simCpuTemp += (targetTemp - simCpuTemp) * 0.62;
    cpuTemp = Number(simCpuTemp.toFixed(1));
  }

  const targetCpuFanPct = interpolateFanPct(cpuTemp, activeTuner.fan_curve, offsets.manual_fan_override_pct);
  simCpuFanPct += (targetCpuFanPct - simCpuFanPct) * 0.55;
  const cpuFanPct = Number(simCpuFanPct.toFixed(1));
  const cpuFanRpm = Math.round(650 + (cpuFanPct / 100) * 2150);

  const cpuClockMhz = Math.round(Math.max(800, baseClockMhz + offsets.cpu_core_mhz + cpuUsage * 5.2));
  const cpuVoltageMv = Number(
    Math.max(780, Math.min(1450, 990 + cpuUsage * 3.1 + offsets.voltage_offset_mv)).toFixed(1)
  );
  const cpuPackagePowerW = Number(
    Math.max(
      14,
      (16 + cpuUsage * 1.15 + Math.max(0, offsets.cpu_core_mhz) * 0.05) * dyn.powerScale
    ).toFixed(1)
  );

  // GPU telemetry (profile-coupled random load + thermal response)
  const gpuUsage = Number(simGpuLoad.toFixed(1));
  const gpuHeatIn =
    26.5 +
    0.52 * gpuUsage * dyn.powerScale +
    Math.max(0, offsets.gpu_core_mhz) * 0.035 +
    (offsets.power_limit_pct - 100) * 0.16 +
    (Math.random() - 0.5) * 4.2;
  const gpuCooling = (simGpuFanPct / 100) * (dyn.coolingGain + 2);
  const targetGpuTemp = Math.max(30, Math.min(92, gpuHeatIn - gpuCooling * 0.52));
  simGpuTemp += (targetGpuTemp - simGpuTemp) * 0.58;
  const gpuTemp = Number(simGpuTemp.toFixed(1));
  const gpuHotspot = Number((gpuTemp + 7.8 + gpuUsage * 0.06).toFixed(1));

  const targetGpuFanPct = interpolateFanPct(gpuTemp, activeTuner.fan_curve, offsets.manual_fan_override_pct);
  simGpuFanPct += (targetGpuFanPct - simGpuFanPct) * 0.55;
  const gpuFanPct = Number(simGpuFanPct.toFixed(1));
  const gpuFanRpm = Math.round(720 + (gpuFanPct / 100) * 2480);

  const gpuClockMhz = Math.round(Math.max(450, 1420 + gpuUsage * 12.4 + offsets.gpu_core_mhz));
  const gpuMemClockMhz = Math.round(Math.max(800, 9500 + offsets.gpu_mem_mhz));
  const gpuTgpLimitW = Number((320 * dyn.powerScale).toFixed(1));
  const gpuPowerW = Number(
    Math.min(gpuTgpLimitW, Math.max(20, (22 + gpuUsage * 2.85) * dyn.powerScale)).toFixed(1)
  );
  const gpuVoltageMv = Number(
    Math.max(725, Math.min(1150, 795 + gpuUsage * 2.85 + offsets.voltage_offset_mv * 0.65)).toFixed(1)
  );

  // Realistic workload process attribution + historical peak TGP voltage tracking
  const workloadSpecs = [
    { pid: 4120, name: "blender-cycles", cpuShare: 0.34, gpuShare: 0.42, memMb: 2840 },
    { pid: 2890, name: "chrome-gpu-proc", cpuShare: 0.18, gpuShare: 0.19, memMb: 1420 },
    { pid: 1944, name: "python3-telemetry", cpuShare: 0.12, gpuShare: 0.06, memMb: 310 },
    { pid: 5512, name: "ffmpeg-nvenc", cpuShare: 0.14, gpuShare: 0.21, memMb: 890 },
    { pid: 3308, name: "vite-dev-server", cpuShare: 0.09, gpuShare: 0.04, memMb: 485 },
    { pid: 6180, name: "dockerd-engine", cpuShare: 0.07, gpuShare: 0.03, memMb: 640 },
    { pid: 1024, name: "window-compositor", cpuShare: 0.06, gpuShare: 0.05, memMb: 520 },
  ];

  const processes: ProcessMetric[] = workloadSpecs.map((spec, idx) => {
    const jitter = 0.88 + 0.24 * Math.sin(elapsedSec * 0.7 + idx * 1.3);
    const pCpu = Number(Math.max(0.4, Math.min(96, cpuUsage * spec.cpuShare * jitter * 1.4)).toFixed(1));
    const pGpu = Number(Math.max(0.2, Math.min(96, gpuUsage * spec.gpuShare * jitter * 1.3)).toFixed(1));
    const estPower = Number(
      Math.max(0.8, cpuPackagePowerW * spec.cpuShare * jitter + gpuPowerW * spec.gpuShare * jitter * 0.88).toFixed(2)
    );
    const activity = Math.min(1, (pCpu / 45) * 0.35 + (pGpu / 50) * 0.65);
    const instVoltage = Number((745 + activity * Math.max(45, gpuVoltageMv - 745)).toFixed(1));

    const prevRow = processPeaks.get(spec.name);
    const peakVoltage = Number(Math.max(prevRow?.max_tgp_voltage_mv ?? 0, instVoltage).toFixed(1));
    const peakPower = Number(Math.max(prevRow?.max_power_w ?? 0, estPower).toFixed(2));

    if (persistSnapshot || !prevRow) {
      processPeaks.set(spec.name, {
        process_name: spec.name,
        last_pid: spec.pid,
        max_tgp_voltage_mv: peakVoltage,
        max_power_w: peakPower,
        last_cpu_pct: pCpu,
        last_gpu_pct: pGpu,
        sample_count: (prevRow?.sample_count ?? 0) + 1,
        last_seen_at: now.toISOString(),
      });
    }

    return {
      pid: spec.pid,
      name: spec.name,
      cpu_pct: pCpu,
      gpu_pct: pGpu,
      memory_mb: spec.memMb,
      estimated_power_w: estPower,
      peak_tgp_voltage_mv: peakVoltage,
      status: "running",
    };
  });

  const label = now.toTimeString().slice(0, 8);
  const historyPoint: TelemetryHistoryPoint = {
    epoch_ms: epochMs,
    label,
    cpu_temp_c: cpuTemp,
    gpu_temp_c: gpuTemp,
    cpu_power_w: cpuPackagePowerW,
    gpu_power_w: gpuPowerW,
    fan_rpm: cpuFanRpm,
  };

  historyBuffer.push(historyPoint);
  if (historyBuffer.length > MAX_BUFFER_POINTS) {
    historyBuffer.shift();
  }

  if (persistSnapshot) {
    tgpSamples.push({
      recorded_at: now.toISOString(),
      epoch_ms: epochMs,
      cpu_temp_c: cpuTemp,
      gpu_temp_c: gpuTemp,
      cpu_power_w: cpuPackagePowerW,
      gpu_power_w: gpuPowerW,
      total_power_w: Number((cpuPackagePowerW + gpuPowerW).toFixed(1)),
      gpu_voltage_mv: gpuVoltageMv,
      cpu_voltage_mv: cpuVoltageMv,
      fan_rpm: cpuFanRpm,
      fan_pct: cpuFanPct,
      active_profile: activeTuner.active_profile,
    });
    if (tgpSamples.length > 500) {
      tgpSamples.shift();
    }
  }

  const thermalState =
    cpuTemp >= SAFETY_LIMITS.cpu_critical_c || gpuTemp >= SAFETY_LIMITS.gpu_critical_c
      ? "critical"
      : cpuTemp >= SAFETY_LIMITS.cpu_elevated_c || gpuTemp >= SAFETY_LIMITS.gpu_elevated_c
        ? "elevated"
        : "nominal";

  return {
    timestamp: now.toISOString(),
    epoch_ms: epochMs,
    mode: linuxTemp !== null ? "live" : "simulated",
    platform: {
      os: `${os.type()} ${os.release()}`,
      hostname: os.hostname(),
      cpu_model: cpuModel,
      gpu_model: "AeroCool Virtual RTX 4080",
      sensor_sources: sources,
    },
    cpu: {
      temp_c: cpuTemp,
      usage_pct: cpuUsage,
      clock_mhz: cpuClockMhz,
      package_power_w: cpuPackagePowerW,
      voltage_mv: cpuVoltageMv,
      fan_rpm: cpuFanRpm,
      fan_pct: cpuFanPct,
      core_count: coreCount,
    },
    gpu: {
      temp_c: gpuTemp,
      hotspot_c: gpuHotspot,
      usage_pct: gpuUsage,
      clock_mhz: gpuClockMhz,
      memory_clock_mhz: gpuMemClockMhz,
      vram_used_mb: Number((2400 + (gpuUsage / 100) * 7200).toFixed(1)),
      vram_total_mb: 16384,
      power_w: gpuPowerW,
      tgp_limit_w: gpuTgpLimitW,
      voltage_mv: gpuVoltageMv,
      fan_rpm: gpuFanRpm,
      fan_pct: gpuFanPct,
    },
    thermal_state: thermalState,
    active_profile: activeTuner.active_profile,
    fan_curve: structuredClone(activeTuner.fan_curve),
    clock_offsets: structuredClone(activeTuner.clock_offsets),
    processes,
    history_point: historyPoint,
  };
}

// Seed 24 initial historical points (~2 minutes) so charts render smoothly immediately on boot
for (let i = 24; i >= 1; i--) {
  const frame = sampleTelemetryFrame(i % 4 === 0);
  const offsetMs = i * 5000;
  const pastDate = new Date(Date.now() - offsetMs);
  frame.history_point.epoch_ms = pastDate.getTime();
  frame.history_point.label = pastDate.toTimeString().slice(0, 8);
  historyBuffer[historyBuffer.length - 1] = frame.history_point;
  latestFrame = frame;
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // REST API routes matching aerocool-monitor FastAPI backend
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      app: "AeroCool Monitor",
      version: "1.0.0",
      mode: latestFrame?.mode ?? "initializing",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/telemetry/current", (_req: Request, res: Response) => {
    if (!latestFrame) {
      latestFrame = sampleTelemetryFrame(true);
    }
    res.json(latestFrame);
  });

  app.get("/api/telemetry/history", (req: Request, res: Response) => {
    const minutes = Math.max(1, Math.min(120, Number(req.query.minutes ?? 15)));
    const cutoff = Date.now() - minutes * 60 * 1000;
    const points = historyBuffer.filter((p) => p.epoch_ms >= cutoff);

    const avgCpu = points.length
      ? Number((points.reduce((a, b) => a + b.cpu_temp_c, 0) / points.length).toFixed(1))
      : 0;
    const maxCpu = points.length ? Number(Math.max(...points.map((p) => p.cpu_temp_c)).toFixed(1)) : 0;
    const avgGpu = points.length
      ? Number((points.reduce((a, b) => a + b.gpu_temp_c, 0) / points.length).toFixed(1))
      : 0;
    const maxGpu = points.length ? Number(Math.max(...points.map((p) => p.gpu_temp_c)).toFixed(1)) : 0;
    const peakPwr = points.length
      ? Number(Math.max(...points.map((p) => p.cpu_power_w + p.gpu_power_w)).toFixed(1))
      : 0;

    res.json({
      minutes,
      points,
      summary: {
        avg_cpu_temp_c: avgCpu,
        max_cpu_temp_c: maxCpu,
        avg_gpu_temp_c: avgGpu,
        max_gpu_temp_c: maxGpu,
        peak_total_power_w: peakPwr,
      },
    });
  });

  app.get("/api/processes", (req: Request, res: Response) => {
    const frame = latestFrame ?? sampleTelemetryFrame(false);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 12)));
    const sortBy = String(req.query.sort_by ?? "power");
    const procs = [...frame.processes];
    procs.sort((a, b) => {
      if (sortBy === "cpu") return b.cpu_pct - a.cpu_pct;
      if (sortBy === "gpu") return b.gpu_pct - a.gpu_pct;
      if (sortBy === "voltage") return b.peak_tgp_voltage_mv - a.peak_tgp_voltage_mv;
      return b.estimated_power_w - a.estimated_power_w;
    });
    res.json({
      timestamp: frame.timestamp,
      count: Math.min(limit, procs.length),
      processes: procs.slice(0, limit),
    });
  });

  const handleGetTgpHistory = (req: Request, res: Response) => {
    const minutes = Math.max(5, Math.min(1440, Number(req.query.minutes ?? 60)));
    const limit = Math.max(10, Math.min(500, Number(req.query.limit ?? 120)));
    const cutoff = Date.now() - minutes * 60 * 1000;
    const filtered = tgpSamples.filter((s) => s.epoch_ms >= cutoff).slice(-limit);
    const peaks = Array.from(processPeaks.values()).sort((a, b) => b.max_power_w - a.max_power_w);

    const summary = {
      peak_total_power_w: filtered.length ? Math.max(...filtered.map((s) => s.total_power_w)) : 0,
      avg_total_power_w: filtered.length
        ? Number((filtered.reduce((a, b) => a + b.total_power_w, 0) / filtered.length).toFixed(1))
        : 0,
      peak_gpu_voltage_mv: filtered.length ? Math.max(...filtered.map((s) => s.gpu_voltage_mv)) : 0,
      peak_gpu_temp_c: filtered.length ? Math.max(...filtered.map((s) => s.gpu_temp_c)) : 0,
      sample_count: filtered.length,
    };

    res.json({
      minutes,
      samples: filtered,
      process_peaks: peaks,
      summary,
    });
  };

  app.get("/api/processes/tgp-history", handleGetTgpHistory);
  app.get("/api/tgp/history", handleGetTgpHistory);

  app.post("/api/tgp/reset-peaks", (_req: Request, res: Response) => {
    const count = processPeaks.size;
    processPeaks.clear();
    res.json({
      status: "reset",
      cleared_records: count,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/tuner", (_req: Request, res: Response) => {
    res.json(activeTuner);
  });

  app.post("/api/tuner/apply", (req: Request, res: Response) => {
    try {
      const requestedLock = typeof req.body?.locked === "boolean" ? req.body.locked : activeTuner.locked;
      const hasConfigChange =
        req.body?.profile_name !== undefined ||
        req.body?.fan_curve !== undefined ||
        req.body?.clock_offsets !== undefined;

      if (activeTuner.locked && requestedLock !== false && hasConfigChange) {
        res.status(423).json({ detail: "Tuner is locked. Unlock or Reset to Defaults before modifying settings." });
        return;
      }

      let nextProfile = activeTuner.active_profile;
      let nextCurve = activeTuner.fan_curve;
      let nextOffsets = activeTuner.clock_offsets;

      if (req.body?.profile_name) {
        const prof = profilesMap.get(String(req.body.profile_name).trim());
        if (!prof) {
          res.status(404).json({ detail: `Profile '${req.body.profile_name}' not found.` });
          return;
        }
        nextProfile = prof.name;
        nextCurve = structuredClone(prof.fan_curve);
        nextOffsets = structuredClone(prof.clock_offsets);
      }

      if (req.body?.fan_curve !== undefined) {
        nextCurve = validateFanCurve(req.body.fan_curve);
        if (!req.body?.profile_name) nextProfile = "Custom";
      }

      if (req.body?.clock_offsets !== undefined) {
        nextOffsets = clampClockOffsets(req.body.clock_offsets);
        if (!req.body?.profile_name) nextProfile = "Custom";
      }

      activeTuner = {
        ...activeTuner,
        active_profile: nextProfile,
        fan_curve: nextCurve,
        clock_offsets: nextOffsets,
        locked: Boolean(requestedLock),
        updated_at: new Date().toISOString(),
        hardware_apply_status: requestedLock
          ? "Configuration applied and locked"
          : "Configuration applied to thermal loop",
      };
      res.json(activeTuner);
    } catch (err) {
      res.status(422).json({ detail: err instanceof Error ? err.message : "Invalid tuner payload" });
    }
  });

  app.put("/api/tuner/fan-curve", (req: Request, res: Response) => {
    if (activeTuner.locked) {
      res.status(423).json({ detail: "Tuner is locked. Unlock or Reset to Defaults before editing fan curve." });
      return;
    }
    try {
      const validated = validateFanCurve(req.body?.points);
      activeTuner = {
        ...activeTuner,
        active_profile: "Custom",
        fan_curve: validated,
        locked: false,
        updated_at: new Date().toISOString(),
        hardware_apply_status: "Fan curve validated & active in thermal loop",
      };
      res.json(activeTuner);
    } catch (err) {
      res.status(422).json({ detail: err instanceof Error ? err.message : "Invalid fan curve" });
    }
  });

  app.put("/api/tuner/clocks", (req: Request, res: Response) => {
    if (activeTuner.locked) {
      res.status(423).json({ detail: "Tuner is locked. Unlock or Reset to Defaults before editing clock offsets." });
      return;
    }
    const clamped = clampClockOffsets(req.body ?? {});
    activeTuner = {
      ...activeTuner,
      active_profile: "Custom",
      clock_offsets: clamped,
      locked: false,
      updated_at: new Date().toISOString(),
      hardware_apply_status: "Clock & power offsets applied to telemetry loop",
    };
    res.json(activeTuner);
  });

  app.get("/api/tuner/profiles", (_req: Request, res: Response) => {
    const profiles = Array.from(profilesMap.values()).sort((a, b) => {
      if (a.is_builtin !== b.is_builtin) return a.is_builtin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({
      active_profile: activeTuner.active_profile,
      profiles,
    });
  });

  app.post("/api/tuner/profiles", (req: Request, res: Response) => {
    try {
      const name = String(req.body?.name ?? "").trim();
      if (name.length < 2 || name.length > 48) {
        res.status(422).json({ detail: "Profile name must be between 2 and 48 characters." });
        return;
      }
      const description = String(req.body?.description ?? "Custom thermal & clock profile").slice(0, 200);
      const curve = validateFanCurve(req.body?.fan_curve);
      const offsets = clampClockOffsets(req.body?.clock_offsets ?? {});
      const existing = profilesMap.get(name);
      const saved: TunerProfile = {
        name,
        description,
        is_builtin: Boolean(existing?.is_builtin),
        fan_curve: curve,
        clock_offsets: offsets,
        updated_at: new Date().toISOString(),
      };
      profilesMap.set(name, saved);
      activeTuner = {
        ...activeTuner,
        active_profile: name,
        fan_curve: structuredClone(curve),
        clock_offsets: structuredClone(offsets),
        updated_at: saved.updated_at,
        hardware_apply_status: `Saved and activated profile '${name}'`,
      };
      res.status(201).json({ saved_profile: saved, tuner_state: activeTuner });
    } catch (err) {
      res.status(422).json({ detail: err instanceof Error ? err.message : "Failed to save profile" });
    }
  });

  app.post("/api/tuner/profiles/:name/apply", (req: Request, res: Response) => {
    const name = decodeURIComponent(String(req.params.name ?? ""));
    const profile = profilesMap.get(name);
    if (!profile) {
      res.status(404).json({ detail: `Profile '${name}' not found.` });
      return;
    }
      activeTuner = {
        ...activeTuner,
        active_profile: profile.name,
        fan_curve: structuredClone(profile.fan_curve),
        clock_offsets: structuredClone(profile.clock_offsets),
        locked: false,
        updated_at: new Date().toISOString(),
        hardware_apply_status: `Activated profile '${profile.name}'`,
      };
      res.json(activeTuner);
    });

    app.delete("/api/tuner/profiles/:name", (req: Request, res: Response) => {
      const name = decodeURIComponent(String(req.params.name ?? ""));
      const profile = profilesMap.get(name);
      if (!profile) {
        res.status(404).json({ detail: `Profile '${name}' not found.` });
        return;
      }
      if (profile.is_builtin) {
        res.status(400).json({ detail: `Built-in profile '${name}' cannot be deleted.` });
        return;
      }
      profilesMap.delete(name);
      res.json({ deleted: true, name });
    });

    app.post("/api/tuner/reset", (_req: Request, res: Response) => {
      const balanced = profilesMap.get("Balanced")!;
      activeTuner = {
        ...activeTuner,
        active_profile: balanced.name,
        fan_curve: structuredClone(balanced.fan_curve),
        clock_offsets: structuredClone(balanced.clock_offsets),
        locked: false,
        updated_at: new Date().toISOString(),
        hardware_apply_status: "Reset to Balanced factory defaults",
      };
      res.json(activeTuner);
    });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws/telemetry" });

  wss.on("connection", (ws: WebSocket) => {
    if (latestFrame && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(latestFrame));
    }
    ws.on("message", (msg) => {
      if (msg.toString().trim() === "ping" && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    });
  });

  let tick = 0;
  setInterval(() => {
    const persistNow = tick % 5 === 0;
    latestFrame = sampleTelemetryFrame(persistNow);
    const payload = JSON.stringify(latestFrame);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
    tick += 1;
  }, POLL_MS);

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`AeroCool Monitor running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start AeroCool server:", err);
  process.exit(1);
});
