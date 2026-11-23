#!/usr/bin/env python3
"""v1 comparison benchmark (card 22.4): the mock provider directly, through DiRouter and through
LiteLLM, at the same offered load, with the same payload and the same k6 script.

DiRouter and the mock provider run as plain Node processes on the host (no proxy in front), and
LiteLLM runs in a container pointed at the same mock provider. k6 runs in a container and reaches
all three through host.docker.internal. For every run the script records the k6 summary and the
CPU time the gateway (or LiteLLM) used, so overhead can be compared both in latency and in CPU
per request.

Usage:
  python3 scripts/bench/run-v1.py --output <dir> [--duration 30s]
      [--litellm-image ghcr.io/berriai/litellm:<tag>]

LiteLLM is only benchmarked when --litellm-image names an image that is already present locally
(the script never pulls images).
"""
import argparse
import json
from pathlib import Path
import os
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MOCK_PORT, GATEWAY_PORT, LITELLM_PORT = 18190, 18191, 18400
DEV_KEY = "dr-dev-local-0000000000000000"
LITELLM_KEY = "sk-bench-litellm"
LITELLM_CONFIG = f"""model_list:
  - model_name: mock/small
    litellm_params:
      model: openai/mock-small
      api_base: http://host.docker.internal:{MOCK_PORT}/v1
      api_key: sk-mock
litellm_settings:
  drop_params: true
"""


def wait_ready(url, seconds=60):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(1)
    raise RuntimeError(f"{url} did not become ready")


def cpu_seconds(pid):
    """User + system CPU time of a host process, in seconds."""
    raw = subprocess.run(["ps", "-o", "time=", "-p", str(pid)], text=True, capture_output=True).stdout
    parts = [float(p) for p in raw.strip().replace("-", ":").split(":")]
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + part
    return seconds


def container_cpu_seconds(name):
    raw = subprocess.run(
        ["docker", "exec", name, "cat", "/sys/fs/cgroup/cpu.stat"], text=True, capture_output=True
    ).stdout
    for line in raw.splitlines():
        if line.startswith("usage_usec"):
            return int(line.split()[1]) / 1e6
    return 0.0


def k6(output, target, mode, rate, duration, base_url, api_key):
    name = f"{target}-{mode}-{rate}"
    subprocess.run(
        [
            "docker", "run", "--rm",
            "-v", f"{ROOT / 'scripts/bench'}:/bench:ro", "-v", f"{output}:/results",
            "grafana/k6:latest", "run", "--quiet",
            "--summary-export", f"/results/{name}.json",
            "-e", f"TARGET={target}", "-e", f"BASE_URL={base_url}", "-e", f"API_KEY={api_key}",
            "-e", f"MODE={mode}", "-e", f"RATE={rate}", "-e", f"DURATION={duration}",
            "-e", f"STREAM={'true' if mode == 'stream' else 'false'}",
            "/bench/k6-baseline.js",
        ],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    metrics = json.loads((output / f"{name}.json").read_text())["metrics"]
    latency = metrics["request_latency_ms"]
    return {
        "requests": metrics["http_reqs"]["count"],
        "failed": metrics["http_req_failed"]["value"],
        "latencyMs": {k: round(latency[k], 2) for k in ("med", "p(95)", "p(99)", "max")},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--duration", default="30s")
    parser.add_argument("--litellm-image")
    parser.add_argument(
        "--rates", default="nonstream=1000,stream=500",
        help="comma-separated mode=rate pairs, e.g. nonstream=250,nonstream=500",
    )
    args = parser.parse_args()
    output = args.output.resolve()
    cases = [(m, int(r)) for m, r in (pair.split('=') for pair in args.rates.split(','))]
    output.mkdir(parents=True, exist_ok=True)

    for package in ("@dirouter/mock-provider", "@dirouter/gateway"):
        subprocess.run(["pnpm", "exec", "turbo", "run", "build", f"--filter={package}"],
                       cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    env = dict(os.environ)
    env["MASTER_KEY"] = subprocess.run(
        ["node", "-e", "import('./packages/shared/dist/index.js').then(m=>console.log(m.generateKey()))"],
        cwd=ROOT, text=True, capture_output=True, check=True,
    ).stdout.strip()
    env["KEY_PEPPER"] = "p" * 40
    data = output / "gateway-data"
    data.mkdir(exist_ok=True)
    subprocess.run(
        ["node", "scripts/dev-snapshot.mjs", str(data / "snapshot.json"),
         f"http://127.0.0.1:{MOCK_PORT}/v1"],
        cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    quiet = {"LOG_LEVEL": "warn", "SHUTDOWN_DRAIN_MS": "0", "SHUTDOWN_READY_DELAY_MS": "0"}
    mock = subprocess.Popen(["node", "apps/mock-provider/dist/main.js"], cwd=ROOT,
                            env={**env, **quiet, "PORT": str(MOCK_PORT)})
    gateway = subprocess.Popen(["node", "apps/gateway/dist/main.js"], cwd=ROOT,
                               env={**env, **quiet, "PORT": str(GATEWAY_PORT), "DATA_DIR": str(data)})
    litellm = None
    try:
        wait_ready(f"http://127.0.0.1:{MOCK_PORT}/healthz")
        wait_ready(f"http://127.0.0.1:{GATEWAY_PORT}/readyz")
        targets = [
            ("direct", f"http://host.docker.internal:{MOCK_PORT}", "sk-mock", None),
            ("gateway", f"http://host.docker.internal:{GATEWAY_PORT}", DEV_KEY,
             lambda: cpu_seconds(gateway.pid)),
        ]
        if args.litellm_image:
            present = subprocess.run(["docker", "image", "inspect", args.litellm_image],
                                     capture_output=True).returncode == 0
            if present:
                (output / "litellm.yaml").write_text(LITELLM_CONFIG)
                subprocess.run(["docker", "rm", "-f", "dirouter-bench-litellm"], capture_output=True)
                subprocess.run([
                    "docker", "run", "-d", "--name", "dirouter-bench-litellm",
                    "-p", f"127.0.0.1:{LITELLM_PORT}:4000",
                    "-e", f"LITELLM_MASTER_KEY={LITELLM_KEY}",
                    "-v", f"{output / 'litellm.yaml'}:/app/config.yaml:ro",
                    args.litellm_image, "--config", "/app/config.yaml", "--port", "4000",
                ], check=True, stdout=subprocess.DEVNULL)
                litellm = "dirouter-bench-litellm"
                wait_ready(f"http://127.0.0.1:{LITELLM_PORT}/health/liveliness", 180)
                targets.append(("litellm", f"http://host.docker.internal:{LITELLM_PORT}",
                                LITELLM_KEY, lambda: container_cpu_seconds(litellm)))
            else:
                print(f"LiteLLM image {args.litellm_image} is not present locally; skipped.")

        results = {}
        for target, base_url, key, cpu in targets:
            for mode, rate in cases:
                before = cpu() if cpu else None
                summary = k6(output, target, mode, rate, args.duration, base_url, key)
                if cpu:
                    used = cpu() - before
                    summary["cpuSeconds"] = round(used, 2)
                    summary["cpuMsPerRequest"] = round(1000 * used / max(1, summary["requests"]), 3)
                results[f"{target}/{mode}@{rate}"] = summary
                print(f"{target:8} {mode:9} @{rate:5}/s  {json.dumps(summary)}", flush=True)
        (output / "results.json").write_text(json.dumps(results, indent=2))
    finally:
        for process in (gateway, mock):
            process.terminate()
        if litellm:
            subprocess.run(["docker", "rm", "-f", litellm], capture_output=True)


if __name__ == "__main__":
    main()
