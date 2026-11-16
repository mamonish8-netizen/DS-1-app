"""Application configuration, polling rates, and thermal safety boundaries."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Final
from pydantic import BaseModel, Field


BASE_DIR: Final[Path] = Path(__file__).resolve().parent.parent
PROJECT_ROOT: Final[Path] = BASE_DIR.parent
DEFAULT_DB_PATH: Final[Path] = BASE_DIR / "aerocool.db"


class ThermalSafetyLimits(BaseModel):
    """Hard safety thresholds enforced by the tuner and telemetry classifier."""

    cpu_elevated_c: float = 75.0
    cpu_critical_c: float = 90.0
    gpu_elevated_c: float = 74.0
    gpu_critical_c: float = 86.0

    # Fan curve safety constraints
    min_fan_curve_points: int = 3
    max_fan_curve_points: int = 8
    high_temp_threshold_c: int = 85
    high_temp_min_fan_pct: int = 70

    # Clock, power, and voltage bounds
    cpu_core_offset_min_mhz: int = -500
    cpu_core_offset_max_mhz: int = 300
    gpu_core_offset_min_mhz: int = -300
    gpu_core_offset_max_mhz: int = 225
    gpu_mem_offset_min_mhz: int = -500
    gpu_mem_offset_max_mhz: int = 1000
    power_limit_min_pct: int = 50
    power_limit_max_pct: int = 115
    voltage_offset_min_mv: int = -120
    voltage_offset_max_mv: int = 50
    manual_fan_min_pct: int = 20
    manual_fan_max_pct: int = 100


class AppSettings(BaseModel):
    """Runtime settings for FastAPI server, telemetry polling, and SQLite."""

    app_name: str = "AeroCool Monitor"
    app_version: str = "1.0.0"
    host: str = Field(default_factory=lambda: os.getenv("AEROCOOL_HOST", "127.0.0.1"))
    port: int = Field(default_factory=lambda: int(os.getenv("AEROCOOL_PORT", "8000")))

    # Sampling & retention
    poll_interval_seconds: float = Field(
        default_factory=lambda: max(0.5, float(os.getenv("AEROCOOL_POLL_SECONDS", "1.0")))
    )
    history_buffer_seconds: int = 900  # 15 minutes at 1 Hz
    db_write_interval_ticks: int = 5   # Persist 1 TGP snapshot every 5 seconds
    db_retention_hours: int = 72

    # Paths
    db_path: Path = Field(
        default_factory=lambda: Path(os.getenv("AEROCOOL_DB_PATH", str(DEFAULT_DB_PATH)))
    )
    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:8000",
            "http://127.0.0.1:8000",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
        ]
    )

    safety: ThermalSafetyLimits = Field(default_factory=ThermalSafetyLimits)


settings = AppSettings()
