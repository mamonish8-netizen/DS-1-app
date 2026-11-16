"""Cross-platform CPU/GPU hardware telemetry reader with automatic simulation fallback."""

from __future__ import annotations

import math
import os
import platform
import socket
import time
from typing import Any

import psutil
from pydantic import BaseModel

from backend.core.config import settings

try:
    import pynvml  # type: ignore

    _HAS_PYNVML = True
except Exception:
    pynvml = None  # type: ignore
    _HAS_PYNVML = False


class PlatformMetadata(BaseModel):
    os: str
    hostname: str
    cpu_model: str
    gpu_model: str
    sensor_sources: list[str]


class CpuTelemetry(BaseModel):
    temp_c: float
    usage_pct: float
    clock_mhz: float
    package_power_w: float
    voltage_mv: float
    fan_rpm: int
    fan_pct: float
    core_count: int


class GpuTelemetry(BaseModel):
    temp_c: float
    hotspot_c: float
    usage_pct: float
    clock_mhz: float
    memory_clock_mhz: float
    vram_used_mb: float
    vram_total_mb: float
    power_w: float
    tgp_limit_w: float
    voltage_mv: float
    fan_rpm: int
    fan_pct: float


class HardwareSnapshot(BaseModel):
    mode: str  # "live" | "simulated"
    platform: PlatformMetadata
    cpu: CpuTelemetry
    gpu: GpuTelemetry
    thermal_state: str  # "nominal" | "elevated" | "critical"


def interpolate_fan_pct(temp_c: float, fan_curve: list[dict[str, int]], override_pct: int | None) -> float:
    """Compute target fan duty cycle from the active fan curve or manual override."""
    if override_pct is not None:
        return float(max(0, min(100, override_pct)))

    if not fan_curve:
        return 45.0

    ordered = sorted(fan_curve, key=lambda pt: pt["temp_c"])
    if temp_c <= ordered[0]["temp_c"]:
        return float(ordered[0]["fan_pct"])
    if temp_c >= ordered[-1]["temp_c"]:
        return float(ordered[-1]["fan_pct"])

    for idx in range(len(ordered) - 1):
        p0 = ordered[idx]
        p1 = ordered[idx + 1]
        if p0["temp_c"] <= temp_c <= p1["temp_c"]:
            span = max(1, p1["temp_c"] - p0["temp_c"])
            ratio = (temp_c - p0["temp_c"]) / span
            return round(p0["fan_pct"] + ratio * (p1["fan_pct"] - p0["fan_pct"]), 1)

    return float(ordered[-1]["fan_pct"])


class HardwareReader:
    """Reads live hardware sensors via psutil + pynvml with smooth thermal simulation fallback."""

    def __init__(self) -> None:
        self._nvml_initialized = False
        self._nvml_handle: Any = None
        self._gpu_name = "AeroCool Virtual RTX 4080"
        self._cpu_name = self._detect_cpu_model()
        self._hostname = socket.gethostname()
        self._os_label = f"{platform.system()} {platform.release()}"
        self._start_time = time.monotonic()

        # Stateful thermal inertia for smooth simulation fallback
        self._sim_cpu_temp = 46.5
        self._sim_gpu_temp = 44.0
        self._sim_cpu_fan_pct = 38.0
        self._sim_gpu_fan_pct = 36.0

        # Warm up psutil CPU percentage baseline
        psutil.cpu_percent(interval=None)
        self._init_nvml()

    def _detect_cpu_model(self) -> str:
        proc = platform.processor().strip()
        if proc and proc.lower() not in {"x86_64", "amd64", "arm64"}:
            return proc
        if platform.system() == "Linux" and os.path.exists("/proc/cpuinfo"):
            try:
                with open("/proc/cpuinfo", "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        if line.lower().startswith("model name"):
                            return line.split(":", 1)[1].strip()
            except OSError:
                pass
        return f"{platform.machine() or 'Multi-Core'} Workstation CPU"

    def _init_nvml(self) -> None:
        if not _HAS_PYNVML or pynvml is None:
            return
        try:
            pynvml.nvmlInit()
            device_count = pynvml.nvmlDeviceGetCount()
            if device_count > 0:
                self._nvml_handle = pynvml.nvmlDeviceGetHandleByIndex(0)
                raw_name = pynvml.nvmlDeviceGetName(self._nvml_handle)
                self._gpu_name = raw_name.decode("utf-8") if isinstance(raw_name, bytes) else str(raw_name)
                self._nvml_initialized = True
        except Exception:
            self._nvml_initialized = False
            self._nvml_handle = None

    def shutdown(self) -> None:
        if self._nvml_initialized and pynvml is not None:
            try:
                pynvml.nvmlShutdown()
            except Exception:
                pass
            self._nvml_initialized = False

    def _read_psutil_cpu_temp(self) -> float | None:
        if not hasattr(psutil, "sensors_temperatures"):
            return None
        try:
            temps = psutil.sensors_temperatures()
            if not temps:
                return None
            preferred_keys = ("coretemp", "k10temp", "zenpower", "cpu_thermal", "acpitz", "applesmc")
            for key in preferred_keys:
                entries = temps.get(key)
                if entries:
                    valid = [e.current for e in entries if e.current and 5.0 < e.current < 125.0]
                    if valid:
                        return round(sum(valid) / len(valid), 1)
            for entries in temps.values():
                valid = [e.current for e in entries if e.current and 5.0 < e.current < 125.0]
                if valid:
                    return round(sum(valid) / len(valid), 1)
        except Exception:
            return None
        return None

    def _read_psutil_fan_rpm(self) -> int | None:
        if not hasattr(psutil, "sensors_fans"):
            return None
        try:
            fans = psutil.sensors_fans()
            if not fans:
                return None
            rpms: list[int] = []
            for entries in fans.values():
                for entry in entries:
                    if entry.current and entry.current > 0:
                        rpms.append(int(entry.current))
            if rpms:
                return int(sum(rpms) / len(rpms))
        except Exception:
            return None
        return None

    def _read_nvml_gpu(self) -> dict[str, Any] | None:
        if not self._nvml_initialized or self._nvml_handle is None or pynvml is None:
            return None
        try:
            h = self._nvml_handle
            temp_c = float(pynvml.nvmlDeviceGetTemperature(h, pynvml.NVML_TEMPERATURE_GPU))
            util = pynvml.nvmlDeviceGetUtilizationRates(h)
            mem = pynvml.nvmlDeviceGetMemoryInfo(h)
            clock_gfx = float(pynvml.nvmlDeviceGetClockInfo(h, pynvml.NVML_CLOCK_GRAPHICS))
            clock_mem = float(pynvml.nvmlDeviceGetClockInfo(h, pynvml.NVML_CLOCK_MEM))

            try:
                power_mw = float(pynvml.nvmlDeviceGetPowerUsage(h))
                power_w = round(power_mw / 1000.0, 1)
            except Exception:
                power_w = 0.0

            try:
                tgp_limit_mw = float(pynvml.nvmlDeviceGetPowerManagementLimit(h))
                tgp_limit_w = round(tgp_limit_mw / 1000.0, 1)
            except Exception:
                tgp_limit_w = 320.0

            try:
                fan_pct = float(pynvml.nvmlDeviceGetFanSpeed(h))
            except Exception:
                fan_pct = None

            return {
                "temp_c": round(temp_c, 1),
                "hotspot_c": round(temp_c + 9.5, 1),
                "usage_pct": round(float(util.gpu), 1),
                "clock_mhz": round(clock_gfx, 0),
                "memory_clock_mhz": round(clock_mem, 0),
                "vram_used_mb": round(mem.used / (1024 * 1024), 1),
                "vram_total_mb": round(mem.total / (1024 * 1024), 1),
                "power_w": power_w,
                "tgp_limit_w": tgp_limit_w,
                "fan_pct": fan_pct,
            }
        except Exception:
            return None

    def read_snapshot(
        self,
        *,
        fan_curve: list[dict[str, int]],
        clock_offsets: dict[str, Any],
    ) -> HardwareSnapshot:
        """Collect real telemetry if available, blending seamlessly with physics-based fallback."""
        sources: list[str] = []

        # Real CPU utilization and frequency from psutil
        cpu_usage = round(float(psutil.cpu_percent(interval=None)), 1)
        core_count = psutil.cpu_count(logical=True) or os.cpu_count() or 8

        cpu_freq = psutil.cpu_freq()
        base_cpu_clock = round(float(cpu_freq.current), 0) if (cpu_freq and cpu_freq.current > 0) else 3850.0
        if cpu_freq and cpu_freq.current > 0:
            sources.append("psutil.cpu_freq")

        cpu_offset_mhz = float(clock_offsets.get("cpu_core_mhz", 0))
        gpu_core_offset_mhz = float(clock_offsets.get("gpu_core_mhz", 0))
        gpu_mem_offset_mhz = float(clock_offsets.get("gpu_mem_mhz", 0))
        power_limit_pct = float(clock_offsets.get("power_limit_pct", 100))
        voltage_offset_mv = float(clock_offsets.get("voltage_offset_mv", 0))
        manual_fan_override = clock_offsets.get("manual_fan_override_pct")

        elapsed = time.monotonic() - self._start_time
        wave_a = math.sin(elapsed * 0.42)
        wave_b = math.cos(elapsed * 0.27)

        power_scale = max(0.5, min(1.3, power_limit_pct / 100.0))
        load_ceiling = min(98.0, 48.0 + (power_limit_pct - 50.0) * 0.72)
        load_floor = max(8.0, 10.0 + (power_limit_pct - 50.0) * 0.42)

        # CPU Temperature (real or profile-coupled stochastic fallback)
        real_cpu_temp = self._read_psutil_cpu_temp()
        if real_cpu_temp is not None:
            sources.append("psutil.sensors_temperatures")
            cpu_temp = real_cpu_temp
        else:
            import random

            burst = random.choice([-18.0, 0.0, 0.0, 22.0])
            load_factor = max(
                load_floor,
                min(load_ceiling, cpu_usage * 0.35 + (load_floor + load_ceiling) * 0.32 + random.uniform(-16.0, 16.0) + burst),
            )
            heat_input = (
                26.0
                + 0.54 * load_factor * power_scale
                + max(0.0, cpu_offset_mhz) * 0.03
                + voltage_offset_mv * 0.08
                + random.uniform(-2.2, 2.2)
            )
            cooling_factor = (self._sim_cpu_fan_pct / 100.0) * 16.0
            target_cpu_temp = max(32.0, min(95.0, heat_input - cooling_factor * 0.52))
            self._sim_cpu_temp += (target_cpu_temp - self._sim_cpu_temp) * 0.62
            cpu_temp = round(self._sim_cpu_temp, 1)

        target_cpu_fan_pct = interpolate_fan_pct(cpu_temp, fan_curve, manual_fan_override)
        self._sim_cpu_fan_pct += (target_cpu_fan_pct - self._sim_cpu_fan_pct) * 0.55

        real_fan_rpm = self._read_psutil_fan_rpm()
        if real_fan_rpm is not None:
            sources.append("psutil.sensors_fans")
            cpu_fan_rpm = real_fan_rpm
            cpu_fan_pct = round(min(100.0, max(0.0, (real_fan_rpm / 2800.0) * 100.0)), 1)
        else:
            cpu_fan_pct = round(self._sim_cpu_fan_pct, 1)
            cpu_fan_rpm = int(round(650 + (cpu_fan_pct / 100.0) * 2150))

        effective_cpu_clock = round(max(800.0, base_cpu_clock + cpu_offset_mhz + (cpu_usage * 5.2)), 0)
        cpu_voltage_mv = round(max(780.0, min(1450.0, 990.0 + (cpu_usage * 3.1) + voltage_offset_mv)), 1)
        cpu_package_power_w = round(
            max(14.0, (16.0 + cpu_usage * 1.15 + max(0.0, cpu_offset_mhz) * 0.05) * power_scale),
            1,
        )

        # GPU Telemetry (real NVML or smart fallback)
        nvml_data = self._read_nvml_gpu()
        if nvml_data is not None:
            sources.append("pynvml")
            gpu_temp = nvml_data["temp_c"]
            gpu_hotspot = nvml_data["hotspot_c"]
            gpu_usage = nvml_data["usage_pct"]
            gpu_clock = round(max(300.0, nvml_data["clock_mhz"] + gpu_core_offset_mhz), 0)
            gpu_mem_clock = round(max(400.0, nvml_data["memory_clock_mhz"] + gpu_mem_offset_mhz), 0)
            vram_used_mb = nvml_data["vram_used_mb"]
            vram_total_mb = nvml_data["vram_total_mb"]
            gpu_tgp_limit = round(nvml_data["tgp_limit_w"] * power_scale, 1)
            gpu_power = nvml_data["power_w"] or round(22.0 + gpu_usage * 2.1, 1)
            target_gpu_fan_pct = (
                float(nvml_data["fan_pct"])
                if nvml_data["fan_pct"] is not None
                else interpolate_fan_pct(gpu_temp, fan_curve, manual_fan_override)
            )
            self._sim_gpu_fan_pct = target_gpu_fan_pct
        else:
            import random

            gpu_burst = random.choice([-20.0, 0.0, 0.0, 24.0])
            gpu_usage = round(
                max(
                    load_floor,
                    min(load_ceiling, (load_floor + load_ceiling) * 0.5 + 22.0 * wave_b + random.uniform(-16.0, 16.0) + gpu_burst),
                ),
                1,
            )
            gpu_heat_input = (
                26.5
                + 0.52 * gpu_usage * power_scale
                + max(0.0, gpu_core_offset_mhz) * 0.035
                + (power_limit_pct - 100.0) * 0.16
                + random.uniform(-2.0, 2.0)
            )
            gpu_cooling = (self._sim_gpu_fan_pct / 100.0) * 18.0
            target_gpu_temp = max(30.0, min(92.0, gpu_heat_input - gpu_cooling * 0.52))
            self._sim_gpu_temp += (target_gpu_temp - self._sim_gpu_temp) * 0.58
            gpu_temp = round(self._sim_gpu_temp, 1)
            gpu_hotspot = round(gpu_temp + 7.8 + (gpu_usage * 0.06), 1)
            gpu_clock = round(max(450.0, 1420.0 + gpu_usage * 12.4 + gpu_core_offset_mhz), 0)
            gpu_mem_clock = round(max(800.0, 9500.0 + gpu_mem_offset_mhz), 0)
            vram_total_mb = 16384.0
            vram_used_mb = round(2400.0 + (gpu_usage / 100.0) * 7200.0, 1)
            gpu_tgp_limit = round(320.0 * power_scale, 1)
            gpu_power = round(
                min(gpu_tgp_limit, max(20.0, (22.0 + gpu_usage * 2.85) * power_scale)),
                1,
            )
            target_gpu_fan_pct = interpolate_fan_pct(gpu_temp, fan_curve, manual_fan_override)
            self._sim_gpu_fan_pct += (target_gpu_fan_pct - self._sim_gpu_fan_pct) * 0.55

        gpu_fan_pct = round(self._sim_gpu_fan_pct, 1)
        gpu_fan_rpm = int(round(720 + (gpu_fan_pct / 100.0) * 2480))
        gpu_voltage_mv = round(max(725.0, min(1150.0, 815.0 + (gpu_usage * 2.6) + voltage_offset_mv * 0.65)), 1)

        if not sources:
            sources.append("smart_simulation_fallback")
        elif "pynvml" not in sources:
            sources.append("gpu_simulation_fallback")

        mode = "live" if ("psutil.sensors_temperatures" in sources or "pynvml" in sources) else "simulated"

        # Thermal classification
        if cpu_temp >= settings.safety.cpu_critical_c or gpu_temp >= settings.safety.gpu_critical_c:
            thermal_state = "critical"
        elif cpu_temp >= settings.safety.cpu_elevated_c or gpu_temp >= settings.safety.gpu_elevated_c:
            thermal_state = "elevated"
        else:
            thermal_state = "nominal"

        return HardwareSnapshot(
            mode=mode,
            platform=PlatformMetadata(
                os=self._os_label,
                hostname=self._hostname,
                cpu_model=self._cpu_name,
                gpu_model=self._gpu_name,
                sensor_sources=sources,
            ),
            cpu=CpuTelemetry(
                temp_c=cpu_temp,
                usage_pct=cpu_usage,
                clock_mhz=effective_cpu_clock,
                package_power_w=cpu_package_power_w,
                voltage_mv=cpu_voltage_mv,
                fan_rpm=cpu_fan_rpm,
                fan_pct=cpu_fan_pct,
                core_count=core_count,
            ),
            gpu=GpuTelemetry(
                temp_c=gpu_temp,
                hotspot_c=gpu_hotspot,
                usage_pct=gpu_usage,
                clock_mhz=gpu_clock,
                memory_clock_mhz=gpu_mem_clock,
                vram_used_mb=vram_used_mb,
                vram_total_mb=vram_total_mb,
                power_w=gpu_power,
                tgp_limit_w=gpu_tgp_limit,
                voltage_mv=gpu_voltage_mv,
                fan_rpm=gpu_fan_rpm,
                fan_pct=gpu_fan_pct,
            ),
            thermal_state=thermal_state,
        )


hardware_reader = HardwareReader()
