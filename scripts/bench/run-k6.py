#!/usr/bin/env python3
"""Paired direct-vs-gateway k6 benchmark for Sprint 1 (card 9.4).

The same payload and executor run against the mock provider directly and
through the gateway (two replicas behind Traefik) at the same offered load, so
the difference between the two runs is the routing overhead added by DiRouter.
Per-replica CPU and memory are sampled while each run is in flight.

Usage:
  MASTER_KEY=... KEY_PEPPER=... BENCH_DATA_DIR=... \
    python3 scripts/bench/run-k6.py --output <dir> [--duration 60s]
"""
import argparse
import datetime
import json
from pathlib import Path
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
NETWORK = "dirouter-k6-baseline"
APP_CONTAINERS = [
    "dirouter-k6-baseline-mock-provider-1",
    "dirouter-k6-baseline-gateway-1-1",
    "dirouter-k6-baseline-gateway-2-1",
    "dirouter-k6-baseline-edge-1",
]

# Acceptance target of card 9.4: 1000 RPS non-stream and 500 RPS stream.
# The direct baseline runs at the very same rate so the overhead comparison
# stays apples-to-apples.
CASES = [
    ("direct", "nonstream", 1000),
    ("gateway", "nonstream", 1000),
    ("direct", "stream", 500),
    ("gateway", "stream", 500),
]


def sample_resources(path, stop, deadline):
    with path.open("w") as output:
        while not stop.is_set() and time.time() < deadline:
            started = time.time()
            result = subprocess.run(
                ["docker", "stats", "--no-stream", "--format", "{{json .}}", *APP_CONTAINERS],
                text=True, capture_output=True, check=True,
            )
            for line in result.stdout.splitlines():
                row = json.loads(line)
                row["sampledAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                output.write(json.dumps(row, separators=(",", ":")) + "\n")
            output.flush()
            stop.wait(max(0, 1 - (time.time() - started)))


def parse_size(value):
    units = {"B": 1, "kB": 1000, "KB": 1000, "MB": 1000**2, "GB": 1000**3,
             "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3}
    number = float("".join(c for c in value if c.isdigit() or c == "."))
    unit = value[len(str(number)):] if str(number) in value else "".join(c for c in value if c.isalpha())
    return number * units.get(unit, 1)


def summarize_resources(path):
    if not path.exists():
        return {}
    rows = [json.loads(line) for line in path.read_text().splitlines() if line]
    summary = {}
    for name in APP_CONTAINERS:
        samples = [r for r in rows if r["Name"] == name]
        if not samples:
            continue
        cpu = [float(r["CPUPerc"].rstrip("%")) for r in samples]
        memory = [parse_size(r["MemUsage"].split(" / ")[0]) for r in samples]
        summary[name] = {
            "samples": len(samples),
            "cpuPercentMean": round(sum(cpu) / len(cpu), 2),
            "cpuPercentMax": round(max(cpu), 2),
            "memoryBytesMean": round(sum(memory) / len(memory)),
            "memoryBytesMax": round(max(memory)),
        }
    return summary


def k6_command(script, output_dir, target, mode, rate, duration, suffix, combined=False):
    base_url = "http://mock-provider:8090" if target == "direct" else "http://edge"
    return [
        "docker", "run", "--rm", "--network", NETWORK,
        "--cpus=4", "--memory=1g",
        "-v", f"{script.parent}:/scripts:ro", "-v", f"{output_dir}:/results",
        "grafana/k6:latest", "run",
        "--out", f"csv=/results/{target}-{mode}-{suffix}.csv",
        "--summary-export", f"/results/{target}-{mode}-{suffix}.json",
        "-e", f"TARGET={'combined' if combined else target}",
        "-e", f"BASE_URL={base_url}",
        "-e", f"MODE={mode}", "-e", f"RATE={rate}", "-e", f"DURATION={duration}",
        "-e", f"PRE_VUS={'250' if mode == 'stream' else '200'}",
        "-e", "MAX_VUS=1500",
        "-e", "API_KEY=dr-benchmark-000000000000000001",
        "/scripts/k6-baseline.js",
    ]


def execute_case(script, output_dir, target, mode, rate, duration, suffix, combined=False):
    log = output_dir / f"{target}-{mode}-{suffix}.log"
    with log.open("w") as output:
        result = subprocess.run(
            k6_command(script, output_dir, target, mode, rate, duration, suffix, combined),
            stdout=output, stderr=subprocess.STDOUT,
        )
    # k6 exits 99 when a threshold is crossed. That is a measurement result,
    # not a crash: the run is still usable and the threshold state is recorded
    # separately. Any other non-zero exit code means the run itself broke.
    if result.returncode not in (0, 99):
        raise RuntimeError(f"{target}/{mode}/{suffix} failed; see {log.name}")
    return log.name, result.returncode == 99


def read_summary(path):
    metrics = json.loads(path.read_text()).get("metrics", {})
    latency = metrics.get("request_latency_ms", {})
    latency = latency.get("values", latency) if isinstance(latency, dict) else {}
    return {
        "requests": metrics.get("http_reqs", {}).get("count"),
        "failedRate": metrics.get("http_req_failed", {}).get("value"),
        "droppedIterations": metrics.get("dropped_iterations", {}).get("count"),
        "checksFailed": metrics.get("checks", {}).get("fails"),
        "latencyMs": {k: round(v, 3) for k, v in latency.items() if isinstance(v, (int, float))},
    }


def overhead_ms(direct, gateway):
    """Routing overhead: gateway latency minus direct latency, per percentile."""
    result = {}
    for key in ("med", "p(90)", "p(95)", "p(99)", "max"):
        d = direct.get("latencyMs", {}).get(key)
        g = gateway.get("latencyMs", {}).get(key)
        if isinstance(d, (int, float)) and isinstance(g, (int, float)):
            result[key] = round(g - d, 3)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--duration", default="60s")
    parser.add_argument("--repeats", type=int, default=1,
                        help="how often each case is repeated; the median run is reported")
    parser.add_argument("--only", choices=["direct", "gateway", "combined"],
                        help="run only this target (e.g. to redo a single failed case)")
    parser.add_argument("--skip-warmup", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    script = ROOT / "scripts/bench/k6-baseline.js"
    metadata = {
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "duration": args.duration,
        "runs": [],
        "overheadMs": {},
    }
    # When re-running a subset, keep the previously recorded cases so the
    # combined report stays complete.
    if args.only:
        previous = output / "run-metadata.json"
        if previous.exists():
            kept = json.loads(previous.read_text()).get("runs", [])
            replaced = {(args.only, "nonstream"), (args.only, "stream")}
            if args.only == "combined":
                replaced = {("combined", "nonstream")}
            metadata["runs"] = [r for r in kept
                                if (r["target"], r["mode"]) not in replaced]

    def record(target, mode, suffix, rate, combined=False):
        resources = output / f"{target}-{mode}-{suffix}-resources.jsonl"
        stop = threading.Event()
        deadline = time.time() + 75
        sampler = threading.Thread(target=sample_resources, args=(resources, stop, deadline))
        sampler.start()
        try:
            log, crossed = execute_case(script, output, target, mode, rate, args.duration, suffix, combined)
        finally:
            stop.set()
            sampler.join()
        summary_file = output / f"{target}-{mode}-{suffix}.json"
        entry = {
            "target": target,
            "mode": mode,
            "rate": rate,
            "log": log,
            "summary": summary_file.name,
            "thresholdsCrossed": crossed,
            **read_summary(summary_file),
            "resources": summarize_resources(resources),
        }
        metadata["runs"].append(entry)
        (output / "run-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
        return entry

    try:
        if not args.skip_warmup:
            for target, mode, rate in CASES:
                if args.only in ("gateway", "combined"):
                    continue
                print(f"warmup {target} {mode}", flush=True)
                execute_case(script, output, target, mode, rate, "15s", "warmup")
        for target, mode, rate in CASES:
            if args.only and target != args.only:
                continue
            for attempt in range(1, args.repeats + 1):
                suffix = "measure" if args.repeats == 1 else f"measure-{attempt}"
                print(f"measure {target} {mode} (run {attempt}/{args.repeats})", flush=True)
                record(target, mode, suffix, rate)
        if args.only in (None, "combined"):
            for attempt in range(1, args.repeats + 1):
                suffix = "combined" if args.repeats == 1 else f"combined-{attempt}"
                print(f"measure combined (1000 non-stream + 500 stream) run {attempt}/{args.repeats}", flush=True)
                record("combined", "nonstream", suffix, 1000, combined=True)

        by_key = {}
        for key in {(r["target"], r["mode"]) for r in metadata["runs"]}:
            candidates = [r for r in metadata["runs"] if (r["target"], r["mode"]) == key]
            # With repeated runs, keep the median run by p99 so a single noisy
            # execution does not define the reported overhead.
            candidates.sort(key=lambda r: r["latencyMs"].get("p(99)", 0))
            by_key[key] = candidates[len(candidates) // 2]
        for mode in ("nonstream", "stream"):
            direct = by_key.get(("direct", mode))
            gateway = by_key.get(("gateway", mode))
            if direct and gateway:
                metadata["overheadMs"][mode] = overhead_ms(direct, gateway)
        metadata["completedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        metadata["status"] = "completed"
    except Exception as error:
        metadata["status"] = "failed"
        metadata["error"] = str(error)
        raise
    finally:
        (output / "run-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    main()
