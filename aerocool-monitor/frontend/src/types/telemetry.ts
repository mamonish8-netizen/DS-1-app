/**
 * Shared TypeScript interfaces matching the AeroCool Monitor FastAPI Pydantic v2 schemas.
 */

export type SensorMode = "live" | "simulated";
export type ThermalState = "nominal" | "elevated" | "critical";
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline";

export interface PlatformMetadata {
  os: string;
  hostname: string;
  cpu_model: string;
  gpu_model: string;
  sensor_sources: string[];
}

export interface CpuTelemetry {
  temp_c: number;
  usage_pct: number;
  clock_mhz: number;
  package_power_w: number;
  voltage_mv: number;
  fan_rpm: number;
  fan_pct: number;
  core_count: number;
}

export interface GpuTelemetry {
  temp_c: number;
  hotspot_c: number;
  usage_pct: number;
  clock_mhz: number;
  memory_clock_mhz: number;
  vram_used_mb: number;
  vram_total_mb: number;
  power_w: number;
  tgp_limit_w: number;
  voltage_mv: number;
  fan_rpm: number;
  fan_pct: number;
}

export interface FanCurvePoint {
  temp_c: number;
  fan_pct: number;
}

export interface ClockOffsets {
  cpu_core_mhz: number;
  gpu_core_mhz: number;
  gpu_mem_mhz: number;
  power_limit_pct: number;
  voltage_offset_mv: number;
  manual_fan_override_pct: number | null;
}

export interface ProcessMetric {
  pid: number;
  name: string;
  cpu_pct: number;
  gpu_pct: number;
  memory_mb: number;
  estimated_power_w: number;
  peak_tgp_voltage_mv: number;
  status: string;
}

export interface TelemetryHistoryPoint {
  epoch_ms: number;
  label: string;
  cpu_temp_c: number;
  gpu_temp_c: number;
  cpu_power_w: number;
  gpu_power_w: number;
  fan_rpm: number;
}

export interface TelemetryFrame {
  timestamp: string;
  epoch_ms: number;
  mode: SensorMode;
  platform: PlatformMetadata;
  cpu: CpuTelemetry;
  gpu: GpuTelemetry;
  thermal_state: ThermalState;
  active_profile: string;
  fan_curve: FanCurvePoint[];
  clock_offsets: ClockOffsets;
  processes: ProcessMetric[];
  history_point: TelemetryHistoryPoint;
}

export interface TelemetryHistoryResponse {
  minutes: number;
  points: TelemetryHistoryPoint[];
  summary: {
    avg_cpu_temp_c: number;
    max_cpu_temp_c: number;
    avg_gpu_temp_c: number;
    max_gpu_temp_c: number;
    peak_total_power_w: number;
  };
}

export interface TgpSampleRow {
  recorded_at: string;
  epoch_ms: number;
  cpu_temp_c: number;
  gpu_temp_c: number;
  cpu_power_w: number;
  gpu_power_w: number;
  total_power_w: number;
  gpu_voltage_mv: number;
  cpu_voltage_mv: number;
  fan_rpm: number;
  fan_pct: number;
  active_profile: string;
}

export interface ProcessTgpPeakRow {
  process_name: string;
  last_pid: number;
  max_tgp_voltage_mv: number;
  max_power_w: number;
  last_cpu_pct: number;
  last_gpu_pct: number;
  sample_count: number;
  last_seen_at: string;
}

export interface TgpHistoryResponse {
  minutes: number;
  samples: TgpSampleRow[];
  process_peaks: ProcessTgpPeakRow[];
  summary: {
    peak_total_power_w: number;
    avg_total_power_w: number;
    peak_gpu_voltage_mv: number;
    peak_gpu_temp_c: number;
    sample_count: number;
  };
}

export interface ThermalSafetyLimits {
  cpu_elevated_c: number;
  cpu_critical_c: number;
  gpu_elevated_c: number;
  gpu_critical_c: number;
  min_fan_curve_points: number;
  max_fan_curve_points: number;
  high_temp_threshold_c: number;
  high_temp_min_fan_pct: number;
  cpu_core_offset_min_mhz: number;
  cpu_core_offset_max_mhz: number;
  gpu_core_offset_min_mhz: number;
  gpu_core_offset_max_mhz: number;
  gpu_mem_offset_min_mhz: number;
  gpu_mem_offset_max_mhz: number;
  power_limit_min_pct: number;
  power_limit_max_pct: number;
  voltage_offset_min_mv: number;
  voltage_offset_max_mv: number;
  manual_fan_min_pct: number;
  manual_fan_max_pct: number;
}

export interface TunerState {
  active_profile: string;
  fan_curve: FanCurvePoint[];
  clock_offsets: ClockOffsets;
  updated_at: string;
  hardware_apply_status: string;
  safety_limits?: ThermalSafetyLimits;
}

export interface TunerProfile {
  name: string;
  description: string;
  is_builtin: boolean;
  fan_curve: FanCurvePoint[];
  clock_offsets: ClockOffsets;
  updated_at: string;
}

export interface ProfilesListResponse {
  active_profile: string;
  profiles: TunerProfile[];
}

export interface SaveProfileInput {
  name: string;
  description: string;
  fan_curve: FanCurvePoint[];
  clock_offsets: ClockOffsets;
}
