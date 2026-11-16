import type {
  ClockOffsets,
  ConnectionStatus,
  FanCurvePoint,
  ProfilesListResponse,
  SaveProfileInput,
  TelemetryFrame,
  TelemetryHistoryResponse,
  TgpHistoryResponse,
  TunerApplyInput,
  TunerProfile,
  TunerState,
} from "../types/telemetry";

export interface AeroCoolClientOptions {
  baseUrl?: string;
}

export interface TelemetryStreamCallbacks {
  onFrame: (frame: TelemetryFrame) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onError?: (error: Error) => void;
}

function resolveDefaultBaseUrl(): string {
  if (typeof window !== "undefined" && window.location) {
    // When running Vite dev server separately from FastAPI (e.g. :5173 -> :8000),
    // callers can pass VITE_AEROCOOL_API_URL or explicit baseUrl; otherwise use same origin.
    const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    if (metaEnv?.VITE_AEROCOOL_API_URL) {
      return metaEnv.VITE_AEROCOOL_API_URL.replace(/\/+$/, "");
    }
    return window.location.origin.replace(/\/+$/, "");
  }
  return "http://127.0.0.1:8000";
}

function toWebSocketUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class AeroCoolApiClient {
  private readonly baseUrl: string;

  constructor(options: AeroCoolClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? resolveDefaultBaseUrl()).replace(/\/+$/, "");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      ...init,
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { detail?: string; error?: string };
        if (body.detail) detail = body.detail;
        else if (body.error) detail = body.error;
      } catch {
        // Ignore JSON parse errors on non-JSON error responses
      }
      throw new Error(detail);
    }

    return (await response.json()) as T;
  }

  getCurrentTelemetry(): Promise<TelemetryFrame> {
    return this.request<TelemetryFrame>("/api/telemetry/current");
  }

  getTelemetryHistory(minutes = 15): Promise<TelemetryHistoryResponse> {
    return this.request<TelemetryHistoryResponse>(`/api/telemetry/history?minutes=${minutes}`);
  }

  getTgpHistory(minutes = 60, limit = 120): Promise<TgpHistoryResponse> {
    return this.request<TgpHistoryResponse>(`/api/processes/tgp-history?minutes=${minutes}&limit=${limit}`);
  }

  resetTgpPeaks(): Promise<{ status: string; cleared_records: number; timestamp: string }> {
    return this.request("/api/tgp/reset-peaks", { method: "POST" });
  }

  getTunerState(): Promise<TunerState> {
    return this.request<TunerState>("/api/tuner");
  }

  applyTuner(payload: TunerApplyInput): Promise<TunerState> {
    return this.request<TunerState>("/api/tuner/apply", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  updateFanCurve(points: FanCurvePoint[]): Promise<TunerState> {
    return this.request<TunerState>("/api/tuner/fan-curve", {
      method: "PUT",
      body: JSON.stringify({ points }),
    });
  }

  updateClockOffsets(offsets: ClockOffsets): Promise<TunerState> {
    return this.request<TunerState>("/api/tuner/clocks", {
      method: "PUT",
      body: JSON.stringify(offsets),
    });
  }

  listProfiles(): Promise<ProfilesListResponse> {
    return this.request<ProfilesListResponse>("/api/tuner/profiles");
  }

  saveProfile(payload: SaveProfileInput): Promise<{ saved_profile: TunerProfile; tuner_state: TunerState }> {
    return this.request("/api/tuner/profiles", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  applyProfile(name: string): Promise<TunerState> {
    return this.request<TunerState>(`/api/tuner/profiles/${encodeURIComponent(name)}/apply`, {
      method: "POST",
    });
  }

  deleteProfile(name: string): Promise<{ deleted: boolean; name: string }> {
    return this.request(`/api/tuner/profiles/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  resetTuner(): Promise<TunerState> {
    return this.request<TunerState>("/api/tuner/reset", { method: "POST" });
  }

  connectTelemetryStream(callbacks: TelemetryStreamCallbacks): () => void {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let manuallyClosed = false;
    let attempt = 0;

    const cleanupTimers = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const connect = () => {
      if (manuallyClosed) return;
      callbacks.onStatusChange?.(attempt === 0 ? "connecting" : "reconnecting");

      try {
        const wsUrl = toWebSocketUrl(this.baseUrl, "/ws/telemetry");
        ws = new WebSocket(wsUrl);
      } catch (err) {
        callbacks.onError?.(err instanceof Error ? err : new Error("WebSocket initialization failed"));
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        attempt = 0;
        callbacks.onStatusChange?.("connected");
        heartbeatTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send("ping");
          }
        }, 15000);
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(event.data) as TelemetryFrame | { type: "pong" };
          if ("type" in parsed && parsed.type === "pong") {
            return;
          }
          callbacks.onFrame(parsed as TelemetryFrame);
        } catch (err) {
          callbacks.onError?.(err instanceof Error ? err : new Error("Invalid telemetry payload"));
        }
      };

      ws.onerror = () => {
        callbacks.onError?.(new Error("WebSocket telemetry stream error"));
      };

      ws.onclose = () => {
        cleanupTimers();
        if (!manuallyClosed) {
          scheduleReconnect();
        } else {
          callbacks.onStatusChange?.("offline");
        }
      };
    };

    const scheduleReconnect = () => {
      if (manuallyClosed) return;
      attempt += 1;
      callbacks.onStatusChange?.("reconnecting");
      const delayMs = Math.min(10000, 750 * Math.pow(1.5, Math.min(attempt, 6)));
      reconnectTimer = setTimeout(connect, delayMs);
    };

    connect();

    return () => {
      manuallyClosed = true;
      cleanupTimers();
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      callbacks.onStatusChange?.("offline");
    };
  }
}

export const aeroCoolClient = new AeroCoolApiClient();
