"""REST API routes for live telemetry, Screen 2 (TGP history), and Screen 3 (Tuner)."""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel

from backend.core.config import settings
from backend.core.database import db
from backend.services.hardware_reader import (
    CpuTelemetry,
    GpuTelemetry,
    HardwareSnapshot,
    PlatformMetadata,
    hardware_reader,
)
from backend.services.process_monitor import ProcessMetric, process_monitor
from backend.services.tuner_controller import (
    ClockOffsetsPayload,
    FanCurvePoint,
    FanCurveUpdateRequest,
    TunerApplyRequest,
    TunerProfilePayload,
    TunerStateResponse,
    tuner_controller,
)

router = APIRouter(prefix="/api", tags=["aerocool"])


class TelemetryHistoryPoint(BaseModel):
    epoch_ms: int
    label: str
    cpu_temp_c: float
    gpu_temp_c: float
    cpu_power_w: float
    gpu_power_w: float
    fan_rpm: int


class TelemetryFrame(BaseModel):
    timestamp: str
    epoch_ms: int
    mode: str
    platform: PlatformMetadata
    cpu: CpuTelemetry
    gpu: GpuTelemetry
    thermal_state: str
    active_profile: str
    fan_curve: list[FanCurvePoint]
    clock_offsets: ClockOffsetsPayload
    processes: list[ProcessMetric]
    history_point: TelemetryHistoryPoint


async def build_telemetry_frame(persist_peaks: bool = False) -> TelemetryFrame:
    """Assemble a complete TelemetryFrame from hardware reader, process monitor, and tuner state."""
    tuner_state = await tuner_controller.get_state()
    snapshot: HardwareSnapshot = hardware_reader.read_snapshot(
        fan_curve=[pt.model_dump() for pt in tuner_state.fan_curve],
        clock_offsets=tuner_state.clock_offsets.model_dump(),
    )
    processes = await process_monitor.sample_processes(
        snapshot,
        limit=12,
        persist_peaks=persist_peaks,
    )
    now = datetime.now(timezone.utc)
    epoch_ms = int(now.timestamp() * 1000)
    label = now.astimezone().strftime("%H:%M:%S")

    return TelemetryFrame(
        timestamp=now.isoformat(),
        epoch_ms=epoch_ms,
        mode=snapshot.mode,
        platform=snapshot.platform,
        cpu=snapshot.cpu,
        gpu=snapshot.gpu,
        thermal_state=snapshot.thermal_state,
        active_profile=tuner_state.active_profile,
        fan_curve=tuner_state.fan_curve,
        clock_offsets=tuner_state.clock_offsets,
        processes=processes,
        history_point=TelemetryHistoryPoint(
            epoch_ms=epoch_ms,
            label=label,
            cpu_temp_c=snapshot.cpu.temp_c,
            gpu_temp_c=snapshot.gpu.temp_c,
            cpu_power_w=snapshot.cpu.package_power_w,
            gpu_power_w=snapshot.gpu.power_w,
            fan_rpm=snapshot.cpu.fan_rpm,
        ),
    )


@router.get("/health")
async def health_check(request: Request) -> dict[str, Any]:
    latest: TelemetryFrame | None = getattr(request.app.state, "latest_frame", None)
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": settings.app_version,
        "mode": latest.mode if latest else "initializing",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/telemetry/current", response_model=TelemetryFrame)
async def get_current_telemetry(request: Request) -> TelemetryFrame:
    latest: TelemetryFrame | None = getattr(request.app.state, "latest_frame", None)
    if latest is not None:
        return latest
    frame = await build_telemetry_frame(persist_peaks=False)
    request.app.state.latest_frame = frame
    return frame


@router.get("/telemetry/history")
async def get_telemetry_history(
    request: Request,
    minutes: int = Query(default=15, ge=1, le=120),
) -> dict[str, Any]:
    buffer: list[TelemetryHistoryPoint] = list(getattr(request.app.state, "history_buffer", []))
    cutoff_ms = int((time.time() - minutes * 60) * 1000)
    points = [pt.model_dump() for pt in buffer if pt.epoch_ms >= cutoff_ms]

    if not points:
        tgp_data = await db.get_tgp_history(minutes=minutes, limit=300)
        points = [
            {
                "epoch_ms": row["epoch_ms"],
                "label": datetime.fromtimestamp(row["epoch_ms"] / 1000).strftime("%H:%M:%S"),
                "cpu_temp_c": row["cpu_temp_c"],
                "gpu_temp_c": row["gpu_temp_c"],
                "cpu_power_w": row["cpu_power_w"],
                "gpu_power_w": row["gpu_power_w"],
                "fan_rpm": row["fan_rpm"],
            }
            for row in tgp_data["samples"]
        ]

    if points:
        avg_cpu = round(sum(p["cpu_temp_c"] for p in points) / len(points), 1)
        max_cpu = round(max(p["cpu_temp_c"] for p in points), 1)
        avg_gpu = round(sum(p["gpu_temp_c"] for p in points) / len(points), 1)
        max_gpu = round(max(p["gpu_temp_c"] for p in points), 1)
        peak_pwr = round(max(p["cpu_power_w"] + p["gpu_power_w"] for p in points), 1)
    else:
        avg_cpu = max_cpu = avg_gpu = max_gpu = peak_pwr = 0.0

    return {
        "minutes": minutes,
        "points": points,
        "summary": {
            "avg_cpu_temp_c": avg_cpu,
            "max_cpu_temp_c": max_cpu,
            "avg_gpu_temp_c": avg_gpu,
            "max_gpu_temp_c": max_gpu,
            "peak_total_power_w": peak_pwr,
        },
    }


@router.get("/processes")
async def get_processes(
    request: Request,
    limit: int = Query(default=12, ge=1, le=50),
    sort_by: Literal["power", "cpu", "gpu", "voltage"] = Query(default="power"),
) -> dict[str, Any]:
    latest: TelemetryFrame | None = getattr(request.app.state, "latest_frame", None)
    if latest is None:
        latest = await build_telemetry_frame(persist_peaks=False)

    procs = [p.model_dump() for p in latest.processes]
    key_map = {
        "power": "estimated_power_w",
        "cpu": "cpu_pct",
        "gpu": "gpu_pct",
        "voltage": "peak_tgp_voltage_mv",
    }
    procs.sort(key=lambda item: item[key_map[sort_by]], reverse=True)
    return {
        "timestamp": latest.timestamp,
        "count": min(limit, len(procs)),
        "processes": procs[:limit],
    }


@router.get("/processes/tgp-history")
@router.get("/tgp/history")
async def get_tgp_history(
    minutes: int = Query(default=60, ge=5, le=1440),
    limit: int = Query(default=120, ge=10, le=500),
) -> dict[str, Any]:
    """Screen 2 API: Historical TGP power logs and per-app Max TGP Voltage peaks."""
    return await db.get_tgp_history(minutes=minutes, limit=limit)


@router.post("/tgp/reset-peaks")
async def reset_tgp_peaks() -> dict[str, Any]:
    deleted = await db.reset_process_peaks()
    process_monitor.reset_cache()
    return {
        "status": "reset",
        "cleared_records": deleted,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/tuner")
async def get_tuner_state() -> dict[str, Any]:
    """Screen 3 API: Active fan curve, permanent clock offsets, lock status, and safety bounds."""
    state: TunerStateResponse = await tuner_controller.get_state()
    return {
        **state.model_dump(),
        "safety_limits": settings.safety.model_dump(),
    }


@router.post("/tuner/apply", response_model=TunerStateResponse)
async def apply_tuner(payload: TunerApplyRequest) -> TunerStateResponse:
    """Screen 3 unified Apply & Lock endpoint."""
    try:
        return await tuner_controller.apply_tuner(payload)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.put("/tuner/fan-curve", response_model=TunerStateResponse)
async def update_fan_curve(payload: FanCurveUpdateRequest) -> TunerStateResponse:
    try:
        return await tuner_controller.update_fan_curve(payload)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.put("/tuner/clocks", response_model=TunerStateResponse)
async def update_clock_offsets(payload: ClockOffsetsPayload) -> TunerStateResponse:
    try:
        return await tuner_controller.update_clock_offsets(payload)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail=str(exc)) from exc


@router.get("/tuner/profiles")
async def list_tuner_profiles() -> dict[str, Any]:
    profiles = await db.list_profiles()
    state = await tuner_controller.get_state()
    return {
        "active_profile": state.active_profile,
        "profiles": profiles,
    }


@router.post("/tuner/profiles", status_code=status.HTTP_201_CREATED)
async def save_tuner_profile(payload: TunerProfilePayload) -> dict[str, Any]:
    saved = await tuner_controller.save_custom_profile(payload)
    state = await tuner_controller.get_state()
    return {
        "saved_profile": saved,
        "tuner_state": state.model_dump(),
    }


@router.post("/tuner/profiles/{name}/apply", response_model=TunerStateResponse)
async def apply_tuner_profile(name: str) -> TunerStateResponse:
    try:
        return await tuner_controller.apply_profile(name)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.delete("/tuner/profiles/{name}")
async def delete_tuner_profile(name: str) -> dict[str, Any]:
    profile = await db.get_profile(name)
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Profile '{name}' not found.")
    if profile["is_builtin"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Built-in profile '{name}' cannot be deleted.",
        )
    deleted = await db.delete_profile(name)
    return {"deleted": deleted, "name": name}


@router.post("/tuner/reset", response_model=TunerStateResponse)
async def reset_tuner() -> TunerStateResponse:
    return await tuner_controller.reset_to_balanced()
