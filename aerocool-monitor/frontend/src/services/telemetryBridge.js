/**
 * Drop-in Vanilla JS WebSocket & DOM updater for Stitch HTML/JS exports.
 *
 * Bind any DOM node via `data-aerocool="cpu.temp_c"` (or `gpu.power_w`, etc.),
 * spin any SVG fan via `data-aerocool-fan="cpu"` or `data-aerocool-fan="gpu"`,
 * and render Screen 2 process tables into `<tbody data-aerocool-processes>`.
 */

export class AeroCoolBridge {
  /**
   * @param {{ baseUrl?: string, onFrame?: (frame: any) => void, onStatus?: (status: string) => void }} [options]
   */
  constructor(options = {}) {
    const defaultOrigin =
      typeof window !== "undefined" && window.location
        ? window.location.origin
        : "http://127.0.0.1:8000";

    this.baseUrl = (options.baseUrl || defaultOrigin).replace(/\/+$/, "");
    this.onFrame = typeof options.onFrame === "function" ? options.onFrame : null;
    this.onStatus = typeof options.onStatus === "function" ? options.onStatus : null;

    this.ws = null;
    this.reconnectTimer = null;
    this.fanRafId = null;
    this.fanAngles = { cpu: 0, gpu: 0 };
    this.latestFrame = null;
    this.attempt = 0;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._connect();
    this._startFanAnimationLoop();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.fanRafId !== null) {
      cancelAnimationFrame(this.fanRafId);
      this.fanRafId = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._emitStatus("offline");
  }

  /**
   * @param {string} status
   */
  _emitStatus(status) {
    if (this.onStatus) {
      this.onStatus(status);
    }
    document.querySelectorAll("[data-aerocool-status]").forEach((el) => {
      el.textContent = status.toUpperCase();
      el.setAttribute("data-state", status);
    });
  }

  _buildWsUrl() {
    const url = new URL("/ws/telemetry", `${this.baseUrl}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  _connect() {
    if (this.stopped) return;
    this._emitStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    try {
      this.ws = new WebSocket(this._buildWsUrl());
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.attempt = 0;
      this._emitStatus("connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame && frame.type === "pong") return;
        this.latestFrame = frame;
        this._updateDom(frame);
        if (this.onFrame) {
          this.onFrame(frame);
        }
      } catch (err) {
        console.error("[AeroCoolBridge] Failed to parse WebSocket frame:", err);
      }
    };

    this.ws.onclose = () => {
      if (!this.stopped) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
    };
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    this.attempt += 1;
    this._emitStatus("reconnecting");
    const delayMs = Math.min(10000, 800 * Math.pow(1.5, Math.min(this.attempt, 6)));
    this.reconnectTimer = setTimeout(() => this._connect(), delayMs);
  }

  /**
   * Resolves dot-separated keys like "cpu.temp_c" or "gpu.fan_rpm".
   * @param {Record<string, any>} obj
   * @param {string} path
   */
  _readPath(obj, path) {
    return path.split(".").reduce((acc, part) => (acc != null ? acc[part] : undefined), obj);
  }

  /**
   * @param {any} frame
   */
  _updateDom(frame) {
    if (!frame || typeof document === "undefined") return;

    // 1. Update scalar text bindings via [data-aerocool="path"]
    document.querySelectorAll("[data-aerocool]").forEach((el) => {
      const path = el.getAttribute("data-aerocool");
      if (!path) return;
      const val = this._readPath(frame, path);
      if (val !== undefined && val !== null) {
        const suffix = el.getAttribute("data-aerocool-unit") || "";
        el.textContent = `${val}${suffix}`;
      }
    });

    // 2. Update radial progress / gauge stroke-dashoffset or width bars
    document.querySelectorAll("[data-aerocool-bar]").forEach((el) => {
      const path = el.getAttribute("data-aerocool-bar");
      if (!path) return;
      const max = Number(el.getAttribute("data-aerocool-max") || 100);
      const val = Number(this._readPath(frame, path) || 0);
      const pct = Math.max(0, Math.min(100, (val / Math.max(1, max)) * 100));
      el.style.width = `${pct.toFixed(1)}%`;
    });

    // 3. Update Screen 2 process & TGP table body if present
    const tbody = document.querySelector("[data-aerocool-processes]");
    if (tbody && Array.isArray(frame.processes)) {
      tbody.innerHTML = frame.processes
        .map(
          (proc) => `
          <tr>
            <td>${this._escapeHtml(proc.name)} <small>(${proc.pid})</small></td>
            <td>${Number(proc.cpu_pct).toFixed(1)}%</td>
            <td>${Number(proc.gpu_pct).toFixed(1)}%</td>
            <td>${Number(proc.estimated_power_w).toFixed(1)} W</td>
            <td>${Number(proc.peak_tgp_voltage_mv).toFixed(1)} mV</td>
          </tr>`
        )
        .join("");
    }
  }

  /**
   * @param {string} str
   */
  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _startFanAnimationLoop() {
    let lastTime = performance.now();

    const tick = (now) => {
      if (this.stopped) return;
      const dtSeconds = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      if (this.latestFrame && typeof document !== "undefined") {
        const cpuRpm = Number(this.latestFrame.cpu?.fan_rpm || 800);
        const gpuRpm = Number(this.latestFrame.gpu?.fan_rpm || 900);

        // Visually smooth angular velocity scaled from real RPM
        const cpuDegPerSec = Math.min(720, (cpuRpm / 60) * 18);
        const gpuDegPerSec = Math.min(720, (gpuRpm / 60) * 18);

        this.fanAngles.cpu = (this.fanAngles.cpu + cpuDegPerSec * dtSeconds) % 360;
        this.fanAngles.gpu = (this.fanAngles.gpu + gpuDegPerSec * dtSeconds) % 360;

        document.querySelectorAll("[data-aerocool-fan]").forEach((el) => {
          const target = el.getAttribute("data-aerocool-fan") === "gpu" ? "gpu" : "cpu";
          el.style.transform = `rotate(${this.fanAngles[target].toFixed(1)}deg)`;
          el.style.transformOrigin = "center";
        });
      }

      this.fanRafId = requestAnimationFrame(tick);
    };

    this.fanRafId = requestAnimationFrame(tick);
  }

  /**
   * Apply a cooling profile from Vanilla JS button clicks.
   * @param {string} profileName
   */
  async applyProfile(profileName) {
    const res = await fetch(`${this.baseUrl}/api/tuner/profiles/${encodeURIComponent(profileName)}/apply`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(`Failed to apply profile: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Persist updated clock/voltage offsets from Screen 3 sliders.
   * @param {{ cpu_core_mhz: number, gpu_core_mhz: number, gpu_mem_mhz: number, power_limit_pct: number, voltage_offset_mv: number, manual_fan_override_pct: number | null }} offsets
   */
  async updateClockOffsets(offsets) {
    const res = await fetch(`${this.baseUrl}/api/tuner/clocks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offsets),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Failed to update offsets: ${res.status}`);
    }
    return res.json();
  }
}
