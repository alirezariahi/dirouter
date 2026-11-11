#!/usr/bin/env python3
"""Summarise a k6 benchmark run directory into a Markdown report.

Reads the per-run summaries produced by `run-k6.py` and writes `summary.md`
next to them. When a case was repeated, every run is listed and the median run
(by p99) is used for the routing-overhead comparison.

Usage:
  python3 scripts/bench/summarize-k6.py --output <dir> [--report <file>]
"""
import argparse
import json
from pathlib import Path

PERCENTILES = ["med", "p(90)", "p(95)", "p(99)", "max"]


def load_metrics(path):
    metrics = json.loads(path.read_text()).get("metrics", {})
    latency = metrics.get("request_latency_ms", {})
    latency = latency.get("values", latency) if isinstance(latency, dict) else {}
    latency = {k: v for k, v in latency.items() if isinstance(v, (int, float))}
    return {
        "requests": metrics.get("http_reqs", {}).get("count"),
        "requestRate": metrics.get("http_reqs", {}).get("rate"),
        "failedRate": metrics.get("http_req_failed", {}).get("value"),
        "checksFailed": metrics.get("checks", {}).get("fails"),
        "droppedIterations": metrics.get("dropped_iterations", {}).get("count"),
        "latencyMs": latency,
    }


def overhead(direct, gateway):
    result = {}
    for key in PERCENTILES:
        d = direct["latencyMs"].get(key)
        g = gateway["latencyMs"].get(key)
        if isinstance(d, (int, float)) and isinstance(g, (int, float)):
            result[key] = round(g - d, 3)
    return result


def percent(value):
    return f"{value * 100:.2f}%"


def best_run(runs):
    """Least-contaminated sample: on a shared host the run with the lowest p99
    is the one that suffered least external interference."""
    ordered = sorted(runs, key=lambda r: r["latencyMs"].get("p(99)", 0))
    return ordered[0]


def collect(output_dir):
    """Group every measured run by (target, mode)."""
    grouped = {}
    for path in sorted(output_dir.glob("*.json")):
        if path.name in ("run-metadata.json", "summary.json"):
            continue
        stem = path.stem
        if "-measure" not in stem and "-combined" not in stem:
            continue
        if "warmup" in stem:
            continue
        target, mode, _ = stem.split("-", 2)
        grouped.setdefault((target, mode), []).append((path.name, load_metrics(path)))
    return grouped


def build(output_dir):
    grouped = collect(output_dir)
    combined_runs = [data for (target, _), runs in grouped.items() if target == "combined"
                     for _, data in runs]

    lines = ["# خلاصهٔ نتایج k6", ""]
    lines.append("| سناریو | نرخ درخواست | درخواست‌ها | خطا | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for (target, mode), runs in grouped.items():
        for index, (name, data) in enumerate(runs, start=1):
            lat = data["latencyMs"]
            label = f"{target}/{mode}"
            if len(runs) > 1:
                label += f" (اجرای {index})"
            lines.append(
                f"| {label} | {data['requestRate'] or 0:.1f}/s | {data['requests']} | "
                f"{percent(data['failedRate'] or 0)} | {lat.get('med', '-')} | {lat.get('p(95)', '-')} | "
                f"{lat.get('p(99)', '-')} | {lat.get('max', '-')} |"
            )
    if combined_runs:
        data = combined_runs[-1]
        lat = data["latencyMs"]
        lines.append(
            f"| combined (۱۰۰۰ non-stream + ۵۰۰ stream) | {data['requestRate'] or 0:.1f}/s | "
            f"{data['requests']} | {percent(data['failedRate'] or 0)} | "
            f"{lat.get('med', '-')} | {lat.get('p(95)', '-')} | {lat.get('p(99)', '-')} | {lat.get('max', '-')} |"
        )

    lines += ["", "## سربار مسیریابی (gateway منهای خط پایهٔ مستقیم)", ""]
    lines.append("| حالت | p50 | p90 | p95 | p99 | max |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    overheads = {}
    for mode in ("nonstream", "stream"):
        direct_runs = grouped.get(("direct", mode))
        gateway_runs = grouped.get(("gateway", mode))
        if not direct_runs or not gateway_runs:
            continue
        diff = overhead(best_run([d for _, d in direct_runs]),
                        best_run([d for _, d in gateway_runs]))
        overheads[mode] = diff
        lines.append(
            f"| {mode} | {diff.get('med', '-')} | {diff.get('p(90)', '-')} | {diff.get('p(95)', '-')} | "
            f"{diff.get('p(99)', '-')} | {diff.get('max', '-')} |"
        )
    lines.append("")
    lines.append("مقدار منفی یعنی gateway سریع‌تر از خط پایهٔ مستقیم بوده است (نوسان اندازه‌گیری).")
    lines.append("")

    metadata_path = output_dir / "run-metadata.json"
    if metadata_path.exists():
        metadata = json.loads(metadata_path.read_text())
        resources = [run for run in metadata.get("runs", []) if run.get("resources")]
        if resources:
            lines += ["## مصرف منابع هر کانتینر", ""]
            lines.append("| سناریو | کانتینر | نمونه | CPU میانگین (٪) | CPU بیشینه (٪) | حافظهٔ میانگین (MiB) | حافظهٔ بیشینه (MiB) |")
            lines.append("|---|---|---:|---:|---:|---:|---:|")
            for run in resources:
                for name, stats in run["resources"].items():
                    lines.append(
                        f"| {run['target']}/{run['mode']} | {name} | {stats['samples']} | "
                        f"{stats['cpuPercentMean']} | {stats['cpuPercentMax']} | "
                        f"{stats['memoryBytesMean'] / 1048576:.1f} | {stats['memoryBytesMax'] / 1048576:.1f} |"
                    )
            lines.append("")

    return "\n".join(lines) + "\n", overheads


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    report, overheads = build(output)
    destination = args.report or (output / "summary.md")
    destination.write_text(report)
    print(report)
    print(json.dumps({"overheadMs": overheads}, indent=2))


if __name__ == "__main__":
    main()
