"""One-command launcher for AeroCool Monitor (starts FastAPI + opens browser)."""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"


def is_port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def wait_for_backend(url: str, timeout_seconds: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def ensure_dependencies() -> None:
    required = ["fastapi", "uvicorn", "psutil", "aiosqlite", "pydantic"]
    missing: list[str] = []
    for mod in required:
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)

    if not missing:
        return

    req_file = BACKEND_DIR / "requirements.txt"
    print(f"[AeroCool] Missing Python packages: {', '.join(missing)}")
    print(f"[AeroCool] Installing from {req_file}...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", str(req_file)])


def main() -> int:
    parser = argparse.ArgumentParser(description="Launch AeroCool Monitor backend and open browser UI.")
    parser.add_argument("--host", default=os.getenv("AEROCOOL_HOST", "127.0.0.1"), help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=int(os.getenv("AEROCOOL_PORT", "8000")), help="Bind port (default: 8000)")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open the browser")
    parser.add_argument("--reload", action="store_true", help="Enable Uvicorn auto-reload for development")
    args = parser.parse_args()

    ensure_dependencies()

    target_url = f"http://{args.host}:{args.port}"
    health_url = f"{target_url}/api/health"

    if is_port_in_use(args.host, args.port):
        print(f"[AeroCool] Port {args.port} is already active at {target_url}.")
        if not args.no_browser:
            webbrowser.open(target_url)
        return 0

    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "backend.main:app",
        "--host",
        args.host,
        "--port",
        str(args.port),
    ]
    if args.reload:
        cmd.append("--reload")

    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT_DIR) + os.pathsep + env.get("PYTHONPATH", "")

    print(f"[AeroCool] Starting FastAPI telemetry server on {target_url} ...")
    process = subprocess.Popen(cmd, cwd=str(ROOT_DIR), env=env)

    try:
        if wait_for_backend(health_url, timeout_seconds=20.0):
            print(f"[AeroCool] Backend healthy at {health_url}")
            if not args.no_browser:
                print(f"[AeroCool] Opening browser -> {target_url}")
                webbrowser.open(target_url)
        else:
            print("[AeroCool] Warning: Server took longer than expected to respond; check logs above.")

        return process.wait()
    except KeyboardInterrupt:
        print("\n[AeroCool] Shutting down telemetry server...")
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
