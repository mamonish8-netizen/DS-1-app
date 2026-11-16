/**
 * Drop-in Vanilla JS WebSocket & DOM updater + interactive control binder for Stitch HTML/JS exports.
 *
 * Supported DOM bindings:
 *   - Text metrics: `data-aerocool="cpu.temp_c"` (with optional `data-aerocool-unit="°C"`)
 *   - Progress bars: `data-aerocool-bar="cpu.usage_pct"` `data-aerocool-max="100"`
 *   - Spinning SVG fans: `data-aerocool-fan="cpu"` or `data-aerocool-fan="gpu"`
 *   - Process TGP table: `<tbody data-aerocool-processes>`
 *   - Cooling profile buttons: `data-aerocool-profile="Balanced"`
 *   - Device selector dropdown: `<select data-aerocool-device>` (`all` | `cpu` | `gpu`)
 *   - TGP session window filter: `data-aerocool-tgp-window="60"`
 *   - Screen 3 controls: `data-aerocool-slider="<field>"`, `data-aerocool-apply`, `data-aerocool-reset`
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
    this.selectedDevice = "all";
    this.attempt = 0;
    this.stopped = false;
    this._boundAbort = null;
  }

  start() {
    this.stopped = false;
    this.bindControls();
    this._connect();
    this._startFanAnimationLoop();
  }

  stop() {
    this.stopped = true;
    if (this._boundAbort) {
      this._boundAbort.abort();
      this._boundAbort = null;
    }
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

  bindControls() {
    if (typeof document === "undefined") return;
    if (this._boundAbort) {
      this._boundAbort.abort();
    }
    this._boundAbort = new AbortController();
    const { signal } = this._boundAbort;

    document.addEventListener(
      "click",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        const profileBtn = target.closest("[data-aerocool-profile]");
        if (profileBtn) {
          const name = profileBtn.getAttribute("data-aerocool-profile");
          if (name) void this.applyProfile(name);
          return;
        }

        const windowBtn = target.closest("[data-aerocool-tgp-window]");
        if (windowBtn) {
          const mins = Number(windowBtn.getAttribute("data-aerocool-tgp-window") || 60);
          void this.fetchTgpHistory(mins);
          return;
        }

        if (target.closest("[data-aerocool-apply]")) {
          const offsets = this._collectSliderOffsets();
          void this.applyTuner({ clock_offsets: offsets, locked: true });
          return;
        }

        if (target.closest("[data-aerocool-reset]")) {
          void this.resetTuner();
        }
      },
      { signal }
    );

    document.addEventListener(
      "change",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        if (target.matches("[data-aerocool-device]") && target instanceof HTMLSelectElement) {
          this.selectedDevice = target.value || "all";
          if (this.latestFrame) {
            this._updateDom(this.latestFrame);
          }
        }
      },
      { signal }
    );
  }

  _collectSliderOffsets() {
    const readVal = (key, fallback) => {
      const el = document.querySelector(`[data-aerocool-slider="${key}"]`);
      if (el && "value" in el) {
        const num = Number(el.value);
        return Number.isFinite(num) ? num : fallback;
      }
      return fallback;
    };

    const current = this.latestFrame?.clock_offsets || {};
    return {
      cpu_core_mhz: readVal("cpu_core_mhz", current.cpu_core_mhz ?? 0),
      gpu_core_mhz: readVal("gpu_core_mhz", current.gpu_core_mhz ?? 0),
      gpu_mem_mhz: readVal("gpu_mem_mhz", current.gpu_mem_mhz ?? 0),
      power_limit_pct: readVal("power_limit_pct", current.power_limit_pct ?? 100),
      voltage_offset_mv: readVal("voltage_offset_mv", current.voltage_offset_mv ?? 0),
      manual_fan_override_pct:
        current.manual_fan_override_pct === undefined ? null : current.manual_fan_override_pct,
    };
  }

  /**
   * @param {string} status
   */
  _emitStatus(status) {
    if (this.onStatus) {
      this.onStatus(status);
    }
    if (typeof document !== "undefined") {
      document.querySelectorAll("[data-aerocool-status]").forEach((el) => {
        el.textContent = status.toUpperCase();
        el.setAttribute("data-state", status);
      });
    }
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

    document.querySelectorAll("[data-aerocool]").forEach((el) => {
      const path = el.getAttribute("data-aerocool");
      if (!path) return;
      const val = this._readPath(frame, path);
      if (val !== undefined && val !== null) {
        const suffix = el.getAttribute("data-aerocool-unit") || "";
        el.textContent = `${val}${suffix}`;
      }
    });

    document.querySelectorAll("[data-aerocool-bar]").forEach((el) => {
      const path = el.getAttribute("data-aerocool-bar");
      if (!path) return;
      const max = Number(el.getAttribute("data-aerocool-max") || 100);
      const val = Number(this._readPath(frame, path) || 0);
      const pct = Math.max(0, Math.min(100, (val / Math.max(1, max)) * 100));
      el.style.width = `${pct.toFixed(1)}%`;
    });

    document.querySelectorAll("[data-aerocool-profile]").forEach((el) => {
      const name = el.getAttribute("data-aerocool-profile");
      el.setAttribute("data-active", name === frame.active_profile ? "true" : "false");
    });

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

  async fetchTgpHistory(minutes = 60, limit = 120) {
    const res = await fetch(`${this.baseUrl}/api/processes/tgp-history?minutes=${minutes}&limit=${limit}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch TGP history: ${res.status}`);
    }
    return res.json();
  }

  async applyProfile(profileName) {
    const res = await fetch(`${this.baseUrl}/api/tuner/profiles/${encodeURIComponent(profileName)}/apply`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(`Failed to apply profile: ${res.status}`);
    }
    return res.json();
  }

  async applyTuner(payload) {
    const res = await fetch(`${this.baseUrl}/api/tuner/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Failed to apply tuner: ${res.status}`);
    }
    return res.json();
  }

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

  async resetTuner() {
    const res = await fetch(`${this.baseUrl}/api/tuner/reset`, { method: "POST" });
    if (!res.ok) {
      throw new Error(`Failed to reset tuner: ${res.status}`);
    }
    return res.json();
  }
}
