# AeroCool Monitor

Smart hardware cooling, thermal telemetry, per-process TGP power attribution, and fan/clock tuning architecture. Built with **FastAPI**, **WebSockets**, **SQLite (`aiosqlite`)**, **`psutil`**, **`pynvml`**, and **TypeScript/React/Vanilla JS** frontend bridges.

---

## Architecture Overview

```text
aerocool-monitor/
├── README.md
├── .gitignore
├── start_app.py                      # One-command launcher (FastAPI + auto browser open)
├── backend/
│   ├── requirements.txt              # FastAPI, Uvicorn, psutil, pynvml, aiosqlite, Pydantic v2
│   ├── main.py                       # FastAPI app, CORS, WebSocket (/ws/telemetry), static mount
│   ├── core/
│   │   ├── config.py                 # Polling rates & thermal safety bounds
│   │   └── database.py               # Async SQLite (`aerocool.db`) for TGP logs & tuner profiles
│   ├── services/
│   │   ├── hardware_reader.py        # CPU/GPU temp, fan RPM & % + Smart Simulation Fallback
│   │   ├── process_monitor.py        # Per-app CPU%, GPU%, Power (W), & Max TGP Voltage tracker
│   │   └── tuner_controller.py       # Fan curve & permanent clock offset controller + validation
│   └── api/
│       └── routes.py                 # REST endpoints for Telemetry, Screen 2 (TGP), & Screen 3 (Tuner)
└── frontend/
    └── src/
        ├── types/
        │   └── telemetry.ts          # Shared TypeScript contracts matching Pydantic schemas
        ├── services/
        │   ├── apiClient.ts          # Typed REST + WebSocket client with auto-reconnect
        │   └── telemetryBridge.js    # Drop-in Vanilla JS WebSocket & DOM updater for Stitch HTML
        └── hooks/
            └── useAeroCool.tsx       # React/TSX hook for live gauges, 15m chart, & tuner sliders
```

---

## 1. Local Setup & One-Command Run (Google Antigravity / Local Machine)

### Prerequisites
- **Python 3.10+** (`python --version` or `python3 --version`)
- **Node.js 18+** (optional, if building a React/Vite frontend)

### Create Virtual Environment & Install Backend Dependencies

```bash
cd aerocool-monitor
python -m venv .venv

# macOS / Linux:
source .venv/bin/activate
# Windows (PowerShell):
# .venv\Scripts\Activate.ps1

pip install -r backend/requirements.txt
```

### Run Everything with One Command

```bash
python start_app.py
```

`start_app.py` automatically:
1. Verifies required Python packages.
2. Starts the FastAPI + WebSocket server at `http://127.0.0.1:8000`.
3. Waits for `/api/health` to report `200 OK` and opens your default web browser.

> **Tip:** To run in development mode with live auto-reload while keeping your Stitch/Vite frontend on port `5173` or `3000`:
> ```bash
> python start_app.py --reload --no-browser
> ```

---

## 2. Frontend Integration Guide

### Option A: React / TSX (Stitch React Export or Vite App)
Copy `frontend/src/types/telemetry.ts`, `frontend/src/services/apiClient.ts`, and `frontend/src/hooks/useAeroCool.tsx` into your React project and bind directly:

```tsx
import { useAeroCool } from "./hooks/useAeroCool";

export function Dashboard() {
  const {
    telemetry,
    history15m,
    tgpHistory,
    tunerState,
    connectionStatus,
    updateFanCurve,
    updateClockOffsets,
    applyProfile,
  } = useAeroCool();

  if (!telemetry) return <div>Connecting to AeroCool telemetry...</div>;

  return (
    <div>
      <h1>CPU: {telemetry.cpu.temp_c}°C ({telemetry.cpu.fan_rpm} RPM)</h1>
      <h2>GPU: {telemetry.gpu.temp_c}°C ({telemetry.gpu.power_w} W)</h2>
    </div>
  );
}
```

### Option B: Drop-in Vanilla HTML / JS (Stitch Static HTML Export)
Include `telemetryBridge.js` in your HTML page and tag elements with `data-aerocool` attributes:

```html
<span data-aerocool="cpu.temp_c">--</span>°C
<span data-aerocool="cpu.fan_rpm">--</span> RPM
<svg data-aerocool-fan="cpu" viewBox="0 0 100 100">...</svg>

<script type="module">
  import { AeroCoolBridge } from "./frontend/src/services/telemetryBridge.js";
  const bridge = new AeroCoolBridge({ baseUrl: "http://127.0.0.1:8000" });
  bridge.start();
</script>
```

---

## 3. API & WebSocket Reference

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/ws/telemetry` | `WS` | Real-time 1 Hz `TelemetryFrame` stream |
| `/api/health` | `GET` | Health status & sensor mode (`live` or `simulated`) |
| `/api/telemetry/current` | `GET` | Latest hardware & process snapshot |
| `/api/telemetry/history?minutes=15` | `GET` | Rolling 15-minute thermal & power chart series |
| `/api/processes` | `GET` | Live per-app CPU%, GPU%, Power (W), & Peak TGP Voltage |
| `/api/tgp/history?minutes=60` | `GET` | Screen 2 SQLite TGP logs & peak voltage leaderboard |
| `/api/tgp/reset-peaks` | `POST` | Reset stored historical Max TGP Voltage records |
| `/api/tuner` | `GET` | Screen 3 active fan curve, clock offsets, & safety limits |
| `/api/tuner/fan-curve` | `PUT` | Validate & persist custom fan curve |
| `/api/tuner/clocks` | `PUT` | Validate & persist permanent clock/voltage/power offsets |
| `/api/tuner/profiles` | `GET` / `POST` | List or save custom profiles in SQLite |
| `/api/tuner/profiles/{name}/apply` | `POST` | Activate a built-in or saved profile |
| `/api/tuner/reset` | `POST` | Reset tuner to `Balanced` factory defaults |

---

## 4. Push to GitHub

```bash
cd aerocool-monitor
git init
git add .
git commit -m "feat: initial AeroCool Monitor telemetry backend and frontend bridge"
git branch -M main
git remote add origin https://github.com/<YOUR_USERNAME>/aerocool-monitor.git
git push -u origin main
```

---

## 5. Cross-Platform Sensor Notes

- **Linux**: Reads `psutil.sensors_temperatures()`, `psutil.sensors_fans()`, and NVIDIA GPUs via `pynvml`.
- **Windows / macOS**: Reads `psutil` CPU utilization, clock frequencies, and process stats natively; engages the **Smart Simulation Fallback** automatically for restricted motherboard/SMC thermal or fan sensors so all gauges, curves, and TGP charts remain responsive.
- **Safety Guarantees**: The tuner backend enforces ascending fan curve breakpoints, a minimum `70%` fan speed at `>= 85°C`, and strict clock/voltage offset clamps before persisting to `aerocool.db`.
