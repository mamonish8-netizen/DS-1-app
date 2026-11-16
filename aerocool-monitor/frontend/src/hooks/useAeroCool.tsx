import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AeroCoolApiClient } from "../services/apiClient";
import type {
  ClockOffsets,
  ConnectionStatus,
  FanCurvePoint,
  SaveProfileInput,
  TelemetryFrame,
  TelemetryHistoryPoint,
  TgpHistoryResponse,
  TunerProfile,
  TunerState,
} from "../types/telemetry";

const MAX_15M_POINTS = 900;

export interface UseAeroCoolOptions {
  baseUrl?: string;
  tgpWindowMinutes?: number;
}

export interface UseAeroCoolResult {
  telemetry: TelemetryFrame | null;
  history15m: TelemetryHistoryPoint[];
  tgpHistory: TgpHistoryResponse | null;
  tunerState: TunerState | null;
  profiles: TunerProfile[];
  connectionStatus: ConnectionStatus;
  loading: boolean;
  saving: boolean;
  error: string | null;
  lastSavedAt: string | null;
  clearError: () => void;
  refreshTgpHistory: (minutes?: number) => Promise<void>;
  updateFanCurve: (points: FanCurvePoint[]) => Promise<TunerState | null>;
  updateClockOffsets: (offsets: ClockOffsets) => Promise<TunerState | null>;
  applyProfile: (name: string) => Promise<TunerState | null>;
  saveProfile: (payload: SaveProfileInput) => Promise<TunerProfile | null>;
  deleteProfile: (name: string) => Promise<boolean>;
  resetTuner: () => Promise<TunerState | null>;
  resetTgpPeaks: () => Promise<void>;
}

export function useAeroCool(options: UseAeroCoolOptions = {}): UseAeroCoolResult {
  const client = useMemo(() => new AeroCoolApiClient({ baseUrl: options.baseUrl }), [options.baseUrl]);
  const tgpMinutes = options.tgpWindowMinutes ?? 60;

  const [telemetry, setTelemetry] = useState<TelemetryFrame | null>(null);
  const [history15m, setHistory15m] = useState<TelemetryHistoryPoint[]>([]);
  const [tgpHistory, setTgpHistory] = useState<TgpHistoryResponse | null>(null);
  const [tunerState, setTunerState] = useState<TunerState | null>(null);
  const [profiles, setProfiles] = useState<TunerProfile[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  const mountedRef = useRef<boolean>(true);

  const clearError = useCallback(() => setError(null), []);

  const refreshTgpHistory = useCallback(
    async (minutes = tgpMinutes) => {
      try {
        const data = await client.getTgpHistory(minutes, 120);
        if (mountedRef.current) {
          setTgpHistory(data);
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to load TGP history");
        }
      }
    },
    [client, tgpMinutes]
  );

  useEffect(() => {
    mountedRef.current = true;

    const bootstrap = async () => {
      setLoading(true);
      try {
        const [currentFrame, histResp, tunerResp, profilesResp, tgpResp] = await Promise.all([
          client.getCurrentTelemetry(),
          client.getTelemetryHistory(15),
          client.getTunerState(),
          client.listProfiles(),
          client.getTgpHistory(tgpMinutes, 120),
        ]);

        if (!mountedRef.current) return;
        setTelemetry(currentFrame);
        setHistory15m(histResp.points.slice(-MAX_15M_POINTS));
        setTunerState(tunerResp);
        setProfiles(profilesResp.profiles);
        setTgpHistory(tgpResp);
        setError(null);
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to connect to AeroCool backend");
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    };

    void bootstrap();

    const disconnect = client.connectTelemetryStream({
      onStatusChange: (status) => {
        if (mountedRef.current) {
          setConnectionStatus(status);
        }
      },
      onFrame: (frame) => {
        if (!mountedRef.current) return;
        setTelemetry(frame);
        setHistory15m((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.epoch_ms === frame.history_point.epoch_ms) {
            return prev;
          }
          const next = [...prev, frame.history_point];
          return next.length > MAX_15M_POINTS ? next.slice(-MAX_15M_POINTS) : next;
        });
      },
      onError: (err) => {
        if (mountedRef.current) {
          setError(err.message);
        }
      },
    });

    const tgpInterval = setInterval(() => {
      void refreshTgpHistory(tgpMinutes);
    }, 10000);

    return () => {
      mountedRef.current = false;
      disconnect();
      clearInterval(tgpInterval);
    };
  }, [client, refreshTgpHistory, tgpMinutes]);

  const updateFanCurve = useCallback(
    async (points: FanCurvePoint[]): Promise<TunerState | null> => {
      setSaving(true);
      setError(null);
      try {
        const updated = await client.updateFanCurve(points);
        if (mountedRef.current) {
          setTunerState((prev) => ({
            ...updated,
            safety_limits: prev?.safety_limits,
          }));
          setLastSavedAt(updated.updated_at);
        }
        return updated;
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to update fan curve");
        }
        return null;
      } finally {
        if (mountedRef.current) {
          setSaving(false);
        }
      }
    },
    [client]
  );

  const updateClockOffsets = useCallback(
    async (offsets: ClockOffsets): Promise<TunerState | null> => {
      setSaving(true);
      setError(null);
      try {
        const updated = await client.updateClockOffsets(offsets);
        if (mountedRef.current) {
          setTunerState((prev) => ({
            ...updated,
            safety_limits: prev?.safety_limits,
          }));
          setLastSavedAt(updated.updated_at);
        }
        return updated;
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to update clock offsets");
        }
        return null;
      } finally {
        if (mountedRef.current) {
          setSaving(false);
        }
      }
    },
    [client]
  );

  const applyProfile = useCallback(
    async (name: string): Promise<TunerState | null> => {
      setSaving(true);
      setError(null);
      try {
        const updated = await client.applyProfile(name);
        if (mountedRef.current) {
          setTunerState((prev) => ({
            ...updated,
            safety_limits: prev?.safety_limits,
          }));
          setLastSavedAt(updated.updated_at);
        }
        return updated;
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to apply profile");
        }
        return null;
      } finally {
        if (mountedRef.current) {
          setSaving(false);
        }
      }
    },
    [client]
  );

  const saveProfile = useCallback(
    async (payload: SaveProfileInput): Promise<TunerProfile | null> => {
      setSaving(true);
      setError(null);
      try {
        const result = await client.saveProfile(payload);
        const listResp = await client.listProfiles();
        if (mountedRef.current) {
          setProfiles(listResp.profiles);
          setTunerState((prev) => ({
            ...result.tuner_state,
            safety_limits: prev?.safety_limits,
          }));
          setLastSavedAt(result.tuner_state.updated_at);
        }
        return result.saved_profile;
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to save custom profile");
        }
        return null;
      } finally {
        if (mountedRef.current) {
          setSaving(false);
        }
      }
    },
    [client]
  );

  const deleteProfile = useCallback(
    async (name: string): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        await client.deleteProfile(name);
        const listResp = await client.listProfiles();
        if (mountedRef.current) {
          setProfiles(listResp.profiles);
        }
        return true;
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to delete profile");
        }
        return false;
      } finally {
        if (mountedRef.current) {
          setSaving(false);
        }
      }
    },
    [client]
  );

  const resetTuner = useCallback(async (): Promise<TunerState | null> => {
    setSaving(true);
    setError(null);
    try {
      const updated = await client.resetTuner();
      if (mountedRef.current) {
        setTunerState((prev) => ({
          ...updated,
          safety_limits: prev?.safety_limits,
        }));
        setLastSavedAt(updated.updated_at);
      }
      return updated;
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to reset tuner");
      }
      return null;
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }, [client]);

  const resetTgpPeaks = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await client.resetTgpPeaks();
      await refreshTgpHistory(tgpMinutes);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to reset TGP voltage peaks");
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }, [client, refreshTgpHistory, tgpMinutes]);

  return {
    telemetry,
    history15m,
    tgpHistory,
    tunerState,
    profiles,
    connectionStatus,
    loading,
    saving,
    error,
    lastSavedAt,
    clearError,
    refreshTgpHistory,
    updateFanCurve,
    updateClockOffsets,
    applyProfile,
    saveProfile,
    deleteProfile,
    resetTuner,
    resetTgpPeaks,
  };
}
