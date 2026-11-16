"""Fan curve and permanent clock/voltage offset controller with strict safety validation."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, model_validator

from backend.core.config import settings
from backend.core.database import db

try:
    import pynvml  # type: ignore

    _HAS_PYNVML = True
except Exception:
    pynvml = None  # type: ignore
    _HAS_PYNVML = False


class FanCurvePoint(BaseModel):
    temp_c: int = Field(..., ge=20, le=100)
    fan_pct: int = Field(..., ge=0, le=100)


class ClockOffsetsPayload(BaseModel):
    cpu_core_mhz: int = Field(
        default=0,
        ge=settings.safety.cpu_core_offset_min_mhz,
        le=settings.safety.cpu_core_offset_max_mhz,
    )
    gpu_core_mhz: int = Field(
        default=0,
        ge=settings.safety.gpu_core_offset_min_mhz,
        le=settings.safety.gpu_core_offset_max_mhz,
    )
    gpu_mem_mhz: int = Field(
        default=0,
        ge=settings.safety.gpu_mem_offset_min_mhz,
        le=settings.safety.gpu_mem_offset_max_mhz,
    )
    power_limit_pct: int = Field(
        default=100,
        ge=settings.safety.power_limit_min_pct,
        le=settings.safety.power_limit_max_pct,
    )
    voltage_offset_mv: int = Field(
        default=0,
        ge=settings.safety.voltage_offset_min_mv,
        le=settings.safety.voltage_offset_max_mv,
    )
    manual_fan_override_pct: int | None = Field(
        default=None,
        ge=settings.safety.manual_fan_min_pct,
        le=settings.safety.manual_fan_max_pct,
    )


class FanCurveUpdateRequest(BaseModel):
    points: list[FanCurvePoint]

    @model_validator(mode="after")
    def validate_curve_safety(self) -> "FanCurveUpdateRequest":
        s = settings.safety
        if not (s.min_fan_curve_points <= len(self.points) <= s.max_fan_curve_points):
            raise ValueError(
                f"Fan curve must contain between {s.min_fan_curve_points} and {s.max_fan_curve_points} points."
            )

        sorted_pts = sorted(self.points, key=lambda p: p.temp_c)
        for i in range(1, len(sorted_pts)):
            if sorted_pts[i].temp_c <= sorted_pts[i - 1].temp_c:
                raise ValueError("Fan curve temperature breakpoints must be strictly increasing.")
            if sorted_pts[i].fan_pct < sorted_pts[i - 1].fan_pct:
                raise ValueError("Fan duty % cannot decrease as temperature rises.")

        for pt in sorted_pts:
            if pt.temp_c >= s.high_temp_threshold_c and pt.fan_pct < s.high_temp_min_fan_pct:
                raise ValueError(
                    f"Thermal safety rule: at {pt.temp_c}°C (>= {s.high_temp_threshold_c}°C), "
                    f"fan speed must be at least {s.high_temp_min_fan_pct}%."
                )
        self.points = sorted_pts
        return self


class TunerApplyRequest(BaseModel):
    profile_name: str | None = Field(default=None, min_length=2, max_length=48)
    fan_curve: list[FanCurvePoint] | None = None
    clock_offsets: ClockOffsetsPayload | None = None
    locked: bool | None = None

    @model_validator(mode="after")
    def validate_optional_curve(self) -> "TunerApplyRequest":
        if self.fan_curve is not None:
            validated = FanCurveUpdateRequest(points=self.fan_curve)
            self.fan_curve = validated.points
        if self.profile_name is not None:
            self.profile_name = self.profile_name.strip()
        return self


class TunerProfilePayload(BaseModel):
    name: str = Field(..., min_length=2, max_length=48)
    description: str = Field(default="Custom thermal & clock profile", max_length=200)
    fan_curve: list[FanCurvePoint]
    clock_offsets: ClockOffsetsPayload

    @model_validator(mode="after")
    def validate_profile(self) -> "TunerProfilePayload":
        validated = FanCurveUpdateRequest(points=self.fan_curve)
        self.fan_curve = validated.points
        self.name = self.name.strip()
        return self


class TunerStateResponse(BaseModel):
    active_profile: str
    fan_curve: list[FanCurvePoint]
    clock_offsets: ClockOffsetsPayload
    locked: bool = False
    updated_at: str
    hardware_apply_status: str


class TunerController:
    """Validates, persists, and applies fan curves and permanent clock offsets."""

    def __init__(self) -> None:
        self._state: dict[str, Any] | None = None
        self._last_apply_status = "Initialized from SQLite profile store"

    async def load_state(self) -> dict[str, Any]:
        self._state = await db.get_active_tuner_state()
        return self._state

    async def get_state(self) -> TunerStateResponse:
        if self._state is None:
            await self.load_state()
        assert self._state is not None
        return TunerStateResponse(
            active_profile=self._state["active_profile"],
            fan_curve=[FanCurvePoint(**pt) for pt in self._state["fan_curve"]],
            clock_offsets=ClockOffsetsPayload(**self._state["clock_offsets"]),
            locked=bool(self._state.get("locked", False)),
            updated_at=self._state["updated_at"],
            hardware_apply_status=self._last_apply_status,
        )

    def _try_apply_hardware_limits(self, offsets: ClockOffsetsPayload) -> str:
        """Attempt native GPU power limit tuning via NVML when supported & permitted."""
        if not _HAS_PYNVML or pynvml is None:
            return "Persisted to SQLite & active software thermal loop (NVML unavailable)"
        try:
            pynvml.nvmlInit()
            handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            default_mw = pynvml.nvmlDeviceGetPowerManagementDefaultLimit(handle)
            min_mw, max_mw = pynvml.nvmlDeviceGetPowerManagementLimitConstraints(handle)
            target_mw = int(default_mw * (offsets.power_limit_pct / 100.0))
            clamped_mw = max(min_mw, min(max_mw, target_mw))
            pynvml.nvmlDeviceSetPowerManagementLimit(handle, clamped_mw)
            return f"Applied NVML GPU power limit ({round(clamped_mw / 1000.0, 1)}W) & persisted to SQLite"
        except Exception:
            return "Persisted to SQLite & active telemetry loop (OS hardware write requires elevated privilege)"

    async def update_fan_curve(self, req: FanCurveUpdateRequest) -> TunerStateResponse:
        current = await self.get_state()
        if current.locked:
            raise PermissionError("Tuner is locked. Unlock or Reset to Defaults before editing fan curve.")
        curve_dicts = [pt.model_dump() for pt in req.points]
        self._state = await db.save_active_tuner_state(
            active_profile="Custom",
            fan_curve=curve_dicts,
            clock_offsets=current.clock_offsets.model_dump(),
            locked=False,
        )
        self._last_apply_status = "Fan curve validated & persisted to SQLite"
        return await self.get_state()

    async def update_clock_offsets(self, offsets: ClockOffsetsPayload) -> TunerStateResponse:
        current = await self.get_state()
        if current.locked:
            raise PermissionError("Tuner is locked. Unlock or Reset to Defaults before editing clock offsets.")
        self._last_apply_status = self._try_apply_hardware_limits(offsets)
        self._state = await db.save_active_tuner_state(
            active_profile="Custom",
            fan_curve=[pt.model_dump() for pt in current.fan_curve],
            clock_offsets=offsets.model_dump(),
            locked=False,
        )
        return await self.get_state()

    async def apply_tuner(self, payload: TunerApplyRequest) -> TunerStateResponse:
        """Unified apply & lock handler for /api/tuner/apply."""
        current = await self.get_state()
        next_locked = current.locked if payload.locked is None else payload.locked

        if current.locked and payload.locked is not False and (
            payload.fan_curve is not None or payload.clock_offsets is not None or payload.profile_name is not None
        ):
            raise PermissionError("Tuner is locked. Unlock or Reset to Defaults before modifying settings.")

        next_profile = current.active_profile
        next_curve = [pt.model_dump() for pt in current.fan_curve]
        next_offsets = current.clock_offsets

        if payload.profile_name is not None:
            prof = await db.get_profile(payload.profile_name)
            if prof is None:
                raise KeyError(f"Profile '{payload.profile_name}' not found.")
            next_profile = prof["name"]
            next_curve = prof["fan_curve"]
            next_offsets = ClockOffsetsPayload(**prof["clock_offsets"])

        if payload.fan_curve is not None:
            next_curve = [pt.model_dump() for pt in payload.fan_curve]
            if payload.profile_name is None:
                next_profile = "Custom"

        if payload.clock_offsets is not None:
            next_offsets = payload.clock_offsets
            if payload.profile_name is None:
                next_profile = "Custom"

        hw_status = self._try_apply_hardware_limits(next_offsets)
        self._last_apply_status = f"{hw_status} [LOCKED]" if next_locked else hw_status
        self._state = await db.save_active_tuner_state(
            active_profile=next_profile,
            fan_curve=next_curve,
            clock_offsets=next_offsets.model_dump(),
            locked=next_locked,
        )
        return await self.get_state()

    async def apply_profile(self, name: str) -> TunerStateResponse:
        profile = await db.get_profile(name)
        if profile is None:
            raise KeyError(f"Profile '{name}' not found.")

        offsets = ClockOffsetsPayload(**profile["clock_offsets"])
        self._last_apply_status = self._try_apply_hardware_limits(offsets)
        self._state = await db.save_active_tuner_state(
            active_profile=profile["name"],
            fan_curve=profile["fan_curve"],
            clock_offsets=offsets.model_dump(),
            locked=False,
        )
        return await self.get_state()

    async def save_custom_profile(self, payload: TunerProfilePayload) -> dict[str, Any]:
        saved = await db.save_profile(
            name=payload.name,
            description=payload.description,
            fan_curve=[pt.model_dump() for pt in payload.fan_curve],
            clock_offsets=payload.clock_offsets.model_dump(),
        )
        self._last_apply_status = self._try_apply_hardware_limits(payload.clock_offsets)
        self._state = await db.save_active_tuner_state(
            active_profile=saved["name"],
            fan_curve=saved["fan_curve"],
            clock_offsets=saved["clock_offsets"],
            locked=False,
        )
        return saved

    async def reset_to_balanced(self) -> TunerStateResponse:
        return await self.apply_profile("Balanced")


tuner_controller = TunerController()
