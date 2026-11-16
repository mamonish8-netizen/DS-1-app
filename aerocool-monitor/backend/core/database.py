"""Async SQLite persistence for TGP history, process voltage peaks, and tuner profiles."""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from backend.core.config import settings


DEFAULT_PROFILES: list[dict[str, Any]] = [
    {
        "name": "Silent",
        "description": "Low acoustic footprint with relaxed fan ramp and conservative power target.",
        "is_builtin": True,
        "fan_curve": [
            {"temp_c": 30, "fan_pct": 22},
            {"temp_c": 50, "fan_pct": 32},
            {"temp_c": 65, "fan_pct": 48},
            {"temp_c": 78, "fan_pct": 68},
            {"temp_c": 88, "fan_pct": 85},
        ],
        "clock_offsets": {
            "cpu_core_mhz": -100,
            "gpu_core_mhz": -75,
            "gpu_mem_mhz": 0,
            "power_limit_pct": 85,
            "voltage_offset_mv": -35,
            "manual_fan_override_pct": None,
        },
    },
    {
        "name": "Balanced",
        "description": "Factory thermal equilibrium across daily workloads and gaming.",
        "is_builtin": True,
        "fan_curve": [
            {"temp_c": 30, "fan_pct": 30},
            {"temp_c": 48, "fan_pct": 42},
            {"temp_c": 65, "fan_pct": 60},
            {"temp_c": 78, "fan_pct": 78},
            {"temp_c": 88, "fan_pct": 95},
        ],
        "clock_offsets": {
            "cpu_core_mhz": 0,
            "gpu_core_mhz": 0,
            "gpu_mem_mhz": 0,
            "power_limit_pct": 100,
            "voltage_offset_mv": 0,
            "manual_fan_override_pct": None,
        },
    },
    {
        "name": "Performance",
        "description": "Aggressive boost clocks with proactive mid-band airflow curve.",
        "is_builtin": True,
        "fan_curve": [
            {"temp_c": 30, "fan_pct": 40},
            {"temp_c": 45, "fan_pct": 55},
            {"temp_c": 60, "fan_pct": 72},
            {"temp_c": 74, "fan_pct": 88},
            {"temp_c": 85, "fan_pct": 100},
        ],
        "clock_offsets": {
            "cpu_core_mhz": 125,
            "gpu_core_mhz": 110,
            "gpu_mem_mhz": 350,
            "power_limit_pct": 108,
            "voltage_offset_mv": -20,
            "manual_fan_override_pct": None,
        },
    },
    {
        "name": "Extreme Cooling",
        "description": "Maximum heat dissipation for sustained workstation or benchmark loads.",
        "is_builtin": True,
        "fan_curve": [
            {"temp_c": 30, "fan_pct": 65},
            {"temp_c": 45, "fan_pct": 78},
            {"temp_c": 60, "fan_pct": 90},
            {"temp_c": 75, "fan_pct": 100},
            {"temp_c": 85, "fan_pct": 100},
        ],
        "clock_offsets": {
            "cpu_core_mhz": 200,
            "gpu_core_mhz": 150,
            "gpu_mem_mhz": 500,
            "power_limit_pct": 115,
            "voltage_offset_mv": 15,
            "manual_fan_override_pct": None,
        },
    },
]


class DatabaseManager:
    """Manages async SQLite connections, schema migrations, and telemetry queries."""

    def __init__(self, db_path: str | None = None) -> None:
        self.db_path = str(db_path or settings.db_path)

    async def connect(self) -> aiosqlite.Connection:
        conn = await aiosqlite.connect(self.db_path)
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA journal_mode=WAL;")
        await conn.execute("PRAGMA synchronous=NORMAL;")
        return conn

    async def init_db(self) -> None:
        settings.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = await self.connect()
        try:
            await conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS tgp_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    recorded_at TEXT NOT NULL,
                    epoch_ms INTEGER NOT NULL,
                    cpu_temp_c REAL NOT NULL,
                    gpu_temp_c REAL NOT NULL,
                    cpu_power_w REAL NOT NULL,
                    gpu_power_w REAL NOT NULL,
                    total_power_w REAL NOT NULL,
                    gpu_voltage_mv REAL NOT NULL,
                    cpu_voltage_mv REAL NOT NULL,
                    fan_rpm INTEGER NOT NULL,
                    fan_pct REAL NOT NULL,
                    active_profile TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_tgp_logs_epoch
                    ON tgp_logs(epoch_ms DESC);

                CREATE TABLE IF NOT EXISTS process_tgp_peaks (
                    process_name TEXT PRIMARY KEY,
                    last_pid INTEGER NOT NULL,
                    max_tgp_voltage_mv REAL NOT NULL,
                    max_power_w REAL NOT NULL,
                    last_cpu_pct REAL NOT NULL,
                    last_gpu_pct REAL NOT NULL,
                    sample_count INTEGER NOT NULL DEFAULT 1,
                    last_seen_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS tuner_profiles (
                    name TEXT PRIMARY KEY,
                    description TEXT NOT NULL,
                    is_builtin INTEGER NOT NULL DEFAULT 0,
                    fan_curve_json TEXT NOT NULL,
                    clock_offsets_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS active_tuner_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    active_profile TEXT NOT NULL,
                    fan_curve_json TEXT NOT NULL,
                    clock_offsets_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            await self._seed_defaults(conn)
            await conn.commit()
        finally:
            await conn.close()

    async def _seed_defaults(self, conn: aiosqlite.Connection) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        for profile in DEFAULT_PROFILES:
            await conn.execute(
                """
                INSERT OR IGNORE INTO tuner_profiles
                    (name, description, is_builtin, fan_curve_json, clock_offsets_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    profile["name"],
                    profile["description"],
                    1 if profile["is_builtin"] else 0,
                    json.dumps(profile["fan_curve"]),
                    json.dumps(profile["clock_offsets"]),
                    now_iso,
                ),
            )

        cursor = await conn.execute("SELECT id FROM active_tuner_state WHERE id = 1")
        row = await cursor.fetchone()
        if row is None:
            balanced = DEFAULT_PROFILES[1]
            await conn.execute(
                """
                INSERT INTO active_tuner_state
                    (id, active_profile, fan_curve_json, clock_offsets_json, updated_at)
                VALUES (1, ?, ?, ?, ?)
                """,
                (
                    balanced["name"],
                    json.dumps(balanced["fan_curve"]),
                    json.dumps(balanced["clock_offsets"]),
                    now_iso,
                ),
            )

    async def insert_tgp_log(
        self,
        *,
        recorded_at: str,
        epoch_ms: int,
        cpu_temp_c: float,
        gpu_temp_c: float,
        cpu_power_w: float,
        gpu_power_w: float,
        gpu_voltage_mv: float,
        cpu_voltage_mv: float,
        fan_rpm: int,
        fan_pct: float,
        active_profile: str,
    ) -> None:
        conn = await self.connect()
        try:
            total_power_w = round(cpu_power_w + gpu_power_w, 2)
            await conn.execute(
                """
                INSERT INTO tgp_logs (
                    recorded_at, epoch_ms, cpu_temp_c, gpu_temp_c,
                    cpu_power_w, gpu_power_w, total_power_w,
                    gpu_voltage_mv, cpu_voltage_mv, fan_rpm, fan_pct, active_profile
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    recorded_at,
                    epoch_ms,
                    cpu_temp_c,
                    gpu_temp_c,
                    cpu_power_w,
                    gpu_power_w,
                    total_power_w,
                    gpu_voltage_mv,
                    cpu_voltage_mv,
                    fan_rpm,
                    fan_pct,
                    active_profile,
                ),
            )
            cutoff_ms = int((time.time() - settings.db_retention_hours * 3600) * 1000)
            await conn.execute("DELETE FROM tgp_logs WHERE epoch_ms < ?", (cutoff_ms,))
            await conn.commit()
        finally:
            await conn.close()

    async def upsert_process_peaks(self, processes: list[dict[str, Any]], seen_at: str) -> None:
        if not processes:
            return
        conn = await self.connect()
        try:
            for proc in processes:
                await conn.execute(
                    """
                    INSERT INTO process_tgp_peaks (
                        process_name, last_pid, max_tgp_voltage_mv, max_power_w,
                        last_cpu_pct, last_gpu_pct, sample_count, last_seen_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
                    ON CONFLICT(process_name) DO UPDATE SET
                        last_pid = excluded.last_pid,
                        max_tgp_voltage_mv = MAX(process_tgp_peaks.max_tgp_voltage_mv, excluded.max_tgp_voltage_mv),
                        max_power_w = MAX(process_tgp_peaks.max_power_w, excluded.max_power_w),
                        last_cpu_pct = excluded.last_cpu_pct,
                        last_gpu_pct = excluded.last_gpu_pct,
                        sample_count = process_tgp_peaks.sample_count + 1,
                        last_seen_at = excluded.last_seen_at
                    """,
                    (
                        proc["name"],
                        proc["pid"],
                        proc["peak_tgp_voltage_mv"],
                        proc["estimated_power_w"],
                        proc["cpu_pct"],
                        proc["gpu_pct"],
                        seen_at,
                    ),
                )
            await conn.commit()
        finally:
            await conn.close()

    async def get_process_peaks_map(self) -> dict[str, dict[str, Any]]:
        conn = await self.connect()
        try:
            cursor = await conn.execute(
                """
                SELECT process_name, last_pid, max_tgp_voltage_mv, max_power_w,
                       last_cpu_pct, last_gpu_pct, sample_count, last_seen_at
                FROM process_tgp_peaks
                ORDER BY max_tgp_voltage_mv DESC
                """
            )
            rows = await cursor.fetchall()
            return {row["process_name"]: dict(row) for row in rows}
        finally:
            await conn.close()

    async def get_tgp_history(self, minutes: int = 60, limit: int = 120) -> dict[str, Any]:
        conn = await self.connect()
        try:
            since_ms = int((time.time() - minutes * 60) * 1000)
            cursor = await conn.execute(
                """
                SELECT recorded_at, epoch_ms, cpu_temp_c, gpu_temp_c,
                       cpu_power_w, gpu_power_w, total_power_w,
                       gpu_voltage_mv, cpu_voltage_mv, fan_rpm, fan_pct, active_profile
                FROM tgp_logs
                WHERE epoch_ms >= ?
                ORDER BY epoch_ms DESC
                LIMIT ?
                """,
                (since_ms, limit),
            )
            samples = [dict(r) for r in await cursor.fetchall()]
            samples.reverse()

            peak_cursor = await conn.execute(
                """
                SELECT process_name, last_pid, max_tgp_voltage_mv, max_power_w,
                       last_cpu_pct, last_gpu_pct, sample_count, last_seen_at
                FROM process_tgp_peaks
                ORDER BY max_power_w DESC, max_tgp_voltage_mv DESC
                LIMIT 20
                """
            )
            process_peaks = [dict(r) for r in await peak_cursor.fetchall()]

            agg_cursor = await conn.execute(
                """
                SELECT
                    COALESCE(MAX(total_power_w), 0) AS peak_total_power_w,
                    COALESCE(AVG(total_power_w), 0) AS avg_total_power_w,
                    COALESCE(MAX(gpu_voltage_mv), 0) AS peak_gpu_voltage_mv,
                    COALESCE(MAX(gpu_temp_c), 0) AS peak_gpu_temp_c,
                    COUNT(*) AS sample_count
                FROM tgp_logs
                WHERE epoch_ms >= ?
                """,
                (since_ms,),
            )
            agg_row = await agg_cursor.fetchone()
            summary = dict(agg_row) if agg_row else {
                "peak_total_power_w": 0.0,
                "avg_total_power_w": 0.0,
                "peak_gpu_voltage_mv": 0.0,
                "peak_gpu_temp_c": 0.0,
                "sample_count": 0,
            }
            return {
                "minutes": minutes,
                "samples": samples,
                "process_peaks": process_peaks,
                "summary": summary,
            }
        finally:
            await conn.close()

    async def reset_process_peaks(self) -> int:
        conn = await self.connect()
        try:
            cursor = await conn.execute("DELETE FROM process_tgp_peaks")
            await conn.commit()
            return cursor.rowcount
        finally:
            await conn.close()

    async def get_active_tuner_state(self) -> dict[str, Any]:
        conn = await self.connect()
        try:
            cursor = await conn.execute(
                """
                SELECT active_profile, fan_curve_json, clock_offsets_json, updated_at
                FROM active_tuner_state
                WHERE id = 1
                """
            )
            row = await cursor.fetchone()
            if row is None:
                balanced = DEFAULT_PROFILES[1]
                return {
                    "active_profile": balanced["name"],
                    "fan_curve": balanced["fan_curve"],
                    "clock_offsets": balanced["clock_offsets"],
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            return {
                "active_profile": row["active_profile"],
                "fan_curve": json.loads(row["fan_curve_json"]),
                "clock_offsets": json.loads(row["clock_offsets_json"]),
                "updated_at": row["updated_at"],
            }
        finally:
            await conn.close()

    async def save_active_tuner_state(
        self,
        *,
        active_profile: str,
        fan_curve: list[dict[str, int]],
        clock_offsets: dict[str, Any],
    ) -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).isoformat()
        conn = await self.connect()
        try:
            await conn.execute(
                """
                UPDATE active_tuner_state
                SET active_profile = ?,
                    fan_curve_json = ?,
                    clock_offsets_json = ?,
                    updated_at = ?
                WHERE id = 1
                """,
                (
                    active_profile,
                    json.dumps(fan_curve),
                    json.dumps(clock_offsets),
                    now_iso,
                ),
            )
            await conn.commit()
            return {
                "active_profile": active_profile,
                "fan_curve": fan_curve,
                "clock_offsets": clock_offsets,
                "updated_at": now_iso,
            }
        finally:
            await conn.close()

    async def list_profiles(self) -> list[dict[str, Any]]:
        conn = await self.connect()
        try:
            cursor = await conn.execute(
                """
                SELECT name, description, is_builtin, fan_curve_json, clock_offsets_json, updated_at
                FROM tuner_profiles
                ORDER BY is_builtin DESC, name ASC
                """
            )
            rows = await cursor.fetchall()
            return [
                {
                    "name": row["name"],
                    "description": row["description"],
                    "is_builtin": bool(row["is_builtin"]),
                    "fan_curve": json.loads(row["fan_curve_json"]),
                    "clock_offsets": json.loads(row["clock_offsets_json"]),
                    "updated_at": row["updated_at"],
                }
                for row in rows
            ]
        finally:
            await conn.close()

    async def get_profile(self, name: str) -> dict[str, Any] | None:
        conn = await self.connect()
        try:
            cursor = await conn.execute(
                """
                SELECT name, description, is_builtin, fan_curve_json, clock_offsets_json, updated_at
                FROM tuner_profiles
                WHERE name = ?
                """,
                (name,),
            )
            row = await cursor.fetchone()
            if row is None:
                return None
            return {
                "name": row["name"],
                "description": row["description"],
                "is_builtin": bool(row["is_builtin"]),
                "fan_curve": json.loads(row["fan_curve_json"]),
                "clock_offsets": json.loads(row["clock_offsets_json"]),
                "updated_at": row["updated_at"],
            }
        finally:
            await conn.close()

    async def save_profile(
        self,
        *,
        name: str,
        description: str,
        fan_curve: list[dict[str, int]],
        clock_offsets: dict[str, Any],
    ) -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).isoformat()
        conn = await self.connect()
        try:
            existing = await self.get_profile(name)
            is_builtin = 1 if (existing and existing["is_builtin"]) else 0
            await conn.execute(
                """
                INSERT INTO tuner_profiles
                    (name, description, is_builtin, fan_curve_json, clock_offsets_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    description = excluded.description,
                    fan_curve_json = excluded.fan_curve_json,
                    clock_offsets_json = excluded.clock_offsets_json,
                    updated_at = excluded.updated_at
                """,
                (
                    name,
                    description,
                    is_builtin,
                    json.dumps(fan_curve),
                    json.dumps(clock_offsets),
                    now_iso,
                ),
            )
            await conn.commit()
            return {
                "name": name,
                "description": description,
                "is_builtin": bool(is_builtin),
                "fan_curve": fan_curve,
                "clock_offsets": clock_offsets,
                "updated_at": now_iso,
            }
        finally:
            await conn.close()

    async def delete_profile(self, name: str) -> bool:
        conn = await self.connect()
        try:
            cursor = await conn.execute(
                "DELETE FROM tuner_profiles WHERE name = ? AND is_builtin = 0",
                (name,),
            )
            await conn.commit()
            return cursor.rowcount > 0
        finally:
            await conn.close()


db = DatabaseManager()
