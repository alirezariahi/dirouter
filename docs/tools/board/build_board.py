#!/usr/bin/env python3
"""Build the DiTask board file (dikar.board format version 1) and a Markdown summary from cards_*.py.

Run (from the docs directory):  python3 tools/board/build_board.py
Output: board/dirouter-board.json and board/README.md (both regenerated on every run).
"""
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from cards_s1 import S1  # noqa: E402
from cards_s23 import S2, S3  # noqa: E402

DOCS_DIR = HERE.parent.parent
OUT_DIR = DOCS_DIR / "board"

LABELS = [
    ("gateway", "#0ea5e9"),
    ("control-api", "#6366f1"),
    ("dashboard", "#ec4899"),
    ("infra-docker", "#64748b"),
    ("database", "#8b5cf6"),
    ("resilience", "#f97316"),
    ("security", "#dc2626"),
    ("testing", "#14b8a6"),
    ("docs", "#10b981"),
    ("billing", "#eab308"),
    ("agent-mcp", "#a855f7"),
    ("high-value", "#ef4444"),
]
LABEL_INDEX = {name: i for i, (name, _) in enumerate(LABELS)}

SPRINTS = [
    dict(name="Sprint 1 — MVP: resilient gateway, Docker, Traefik, and basic dashboard",
         goal="An end-to-end gateway behind Traefik that forwards OpenAI and Anthropic requests to multiple providers with fallback, circuit breakers, rate limits, budgets, and accounting; a basic Persian dashboard; Docker deployment and documentation.",
         status="ACTIVE", start="2026-11-07", end="2026-11-20", rank="i", cards=S1),
    dict(name="Sprint 2 — v1: advanced resilience, enterprise security, caching, and analytics",
         goal="Intelligent routing and hedging, caching and compression, MFA/SSO/audit, guardrails, alerts, an analytics dashboard, versioned configuration, and HA deployment with chaos tests.",
         status="PLANNED", start="2026-11-21", end="2026-12-04", rank="r", cards=S2),
    dict(name="Sprint 3 — billing, agents/MCP, and the v1.0 release",
         goal="Wallet and payment gateways, a sales portal, MCP gateway and A2A, classifier routing, multimodality, SAML/SCIM, supply-chain security, benchmarks, and the v1.0 release.",
         status="PLANNED", start="2026-12-05", end="2026-12-18", rank="v", cards=S3),
]

LISTS = [("📥 Backlog", "i"), ("🔎 Ready to start", "r"), ("🛠 In progress", "v"),
         ("👀 Review", "x"), ("✅ Done", "y")]

ACCEPT_TITLE = "Acceptance criteria"
DOD_TITLE = "Definition of Done (DoD)"
DOD = ["Relevant unit/integration tests are written and green in CI",
       "Relevant documentation in docs/ is updated",
       "Run and verified in the docker compose environment",
       "Code review completed and approved"]

PRIORITY_EN = {"URGENT": "Urgent", "HIGH": "High", "MEDIUM": "Medium", "LOW": "Low"}
TYPE_EN = {"STORY": "Story", "TASK": "Task", "BUG": "Bug"}

EPICS = {
    "0": "Architecture and decisions", "1": "Monorepo and tooling", "2": "Docker and Traefik",
    "3": "Database and control-api", "4": "Gateway core", "5": "Routing and resilience",
    "6": "Limits, budgets, and accounting", "7": "MVP dashboard", "8": "Observability",
    "9": "Testing and QA", "10": "MVP documentation", "11": "More APIs and providers",
    "12": "Advanced routing and resilience", "13": "Caching and token savings", "14": "Enterprise security",
    "15": "Guardrails", "16": "Advanced dashboard and alerts", "17": "Configuration, tracing, and HA",
    "18": "Chaos and v1 documentation", "19": "Billing and sales", "20": "Agents, MCP, and intelligent routing",
    "21": "Multimodality and plugins", "22": "Enterprise features, security, and release",
}


def rank(i: int, n: int) -> str:
    """Sortable string rank (two letters a-z) spaced evenly to leave room for later inserts."""
    v = (i + 1) * 676 // (n + 1)
    return chr(97 + v // 26) + chr(97 + v % 26)


def ref_for(key: str) -> str:
    return "cdr" + hashlib.sha1(f"dirouter:{key}".encode()).hexdigest()[:22]


def iso(day: str, end: bool = False) -> str:
    return f"{day}T23:59:59.000Z" if end else f"{day}T00:00:00.000Z"


def describe(c: dict, by_key: dict) -> str:
    parts = [f"## 🎯 Goal\n{c['goal']}", f"## 📋 Work\n{c['work']}",
             f"## ✅ {ACCEPT_TITLE}\n" + "\n".join(f"- [ ] {a}" for a in c["accept"])]
    if c["tech"]:
        parts.append(f"## 🔧 Technical notes\n{c['tech']}")
    if c["deps"]:
        parts.append("## 🔗 Dependencies\n" + "\n".join(
            f"- {d} {by_key[d]['title']}" for d in c["deps"]))
    parts.append(f"## 🏁 {DOD_TITLE}\n" + "\n".join(f"- [ ] {d}" for d in DOD))
    return "\n\n".join(parts)


def checklist(title: str, items: list) -> dict:
    return {"title": title, "rank": "i" if title == ACCEPT_TITLE else "r",
            "items": [{"text": t, "done": False, "rank": rank(i, len(items)), "dueDate": None}
                      for i, t in enumerate(items)]}


def validate(all_cards: list, sprint_of: dict) -> None:
    keys = [c["key"] for c in all_cards]
    dupes = {k for k in keys if keys.count(k) > 1}
    assert not dupes, f"duplicate keys: {dupes}"
    by_key = {c["key"]: c for c in all_cards}
    for c in all_cards:
        for lab in c["labels"]:
            assert lab in LABEL_INDEX, f"{c['key']}: unknown label {lab}"
        assert c["prio"] in PRIORITY_EN and c["type"] in TYPE_EN, c["key"]
        for d in c["deps"]:
            assert d in by_key, f"{c['key']}: missing dependency {d}"
            assert sprint_of[d] <= sprint_of[c["key"]], \
                f"{c['key']} depends on {d} from a later sprint"
    # cycle detection
    state = {}

    def visit(k, path):
        if state.get(k) == 1:
            raise AssertionError("dependency cycle: " + " → ".join(path + [k]))
        if state.get(k) == 2:
            return
        state[k] = 1
        for d in by_key[k]["deps"]:
            visit(d, path + [k])
        state[k] = 2

    for k in keys:
        visit(k, [])


def main() -> None:
    all_cards, sprint_of = [], {}
    for si, sp in enumerate(SPRINTS):
        for c in sp["cards"]:
            sprint_of[c["key"]] = si
            all_cards.append(c)
    validate(all_cards, sprint_of)
    by_key = {c["key"]: c for c in all_cards}

    cards_json = []
    for n, c in enumerate(all_cards, start=1):
        sp = SPRINTS[sprint_of[c["key"]]]
        cards_json.append({
            "ref": ref_for(c["key"]), "number": n,
            "title": f"{c['key']} {c['title']}",
            "description": describe(c, by_key),
            "rank": rank(n - 1, len(all_cards)),
            "dueDate": iso(sp["end"]), "startDate": None, "completed": False, "coverColor": None,
            "estimateMinutes": c["sp"] * 60, "storyPoints": c["sp"],
            "priority": c["prio"], "cardType": c["type"],
            "sprintRef": sprint_of[c["key"]], "epicRef": None,
            "blockedBy": [ref_for(d) for d in c["deps"]], "archived": False,
            "labels": [LABEL_INDEX[lab] for lab in c["labels"]],
            "checklists": [checklist(ACCEPT_TITLE, c["accept"]), checklist(DOD_TITLE, DOD)],
            "fieldValues": [], "worklogs": [],
        })

    board = {
        "type": "dikar.board", "version": 1,
        "exportedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "board": {
            "title": "🧭 DiRouter — intelligent LLM gateway",
            "cardPrefix": "DR", "background": "#0ea5e9", "icon": "🧭",
            "visibility": "WORKSPACE", "starred": False,
            "labels": [{"name": n, "color": col} for n, col in LABELS],
            "customFields": [],
            "sprints": [{"name": s["name"], "goal": s["goal"], "status": s["status"],
                         "startDate": iso(s["start"]), "endDate": iso(s["end"], end=True),
                         "rank": s["rank"]} for s in SPRINTS],
            "epics": [],
            "lists": [{"title": t, "color": None, "rank": r,
                       "cards": cards_json if i == 0 else []} for i, (t, r) in enumerate(LISTS)],
        },
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "dirouter-board.json").write_text(json.dumps(board, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT_DIR / "README.md").write_text(summary_md(all_cards, sprint_of), encoding="utf-8")

    for sp in SPRINTS:
        cs = sp["cards"]
        print(f"{sp['name']}: {len(cs)} cards, {sum(c['sp'] for c in cs)} story points")
    print(f"Total: {len(all_cards)} cards → {OUT_DIR / 'dirouter-board.json'}")


def table(header: list, rows: list) -> list:
    """Markdown table with padded columns (the same layout Prettier produces)."""
    widths = [max(len(str(r[i])) for r in [header, *rows] + [["---"] * len(header)])
              for i in range(len(header))]

    def line(cells):
        return "| " + " | ".join(str(v).ljust(w) for v, w in zip(cells, widths)) + " |"

    return [line(header), "| " + " | ".join("-" * w for w in widths) + " |", *map(line, rows)]


def summary_md(all_cards: list, sprint_of: dict) -> str:
    out = ["# DiRouter board (DiTask)", "",
           "> This file is generated automatically from `tools/board/build_board.py`; do not edit it by hand.", "",
           "## Importing into DiTask", "",
           "Import the `docs/board/dirouter-board.json` file through the \"data transfer / board import\" section "
           "in DiTask. All cards are in the \"📥 Backlog\" list and are linked to their sprints; Sprint 1 is active.", "",
           "## Technology stack", "",
           "- **Backend:** NestJS (on the Fastify adapter) for the gateway, control-api, and worker",
           "- **Frontend:** React + Vite + TypeScript, TanStack Router/Query, shadcn/ui, Tailwind (RTL)",
           "- **Database:** PostgreSQL 17 + Prisma (partitioned logs + aggregate tables)",
           "- **Counters, cache, pub/sub, and queue:** Valkey + BullMQ",
           "- **Reverse proxy:** Traefik v3 (TLS with Let's Encrypt, SSE support)",
           "- **Deployment:** Docker and docker compose (dev, prod, HA); pnpm + Turborepo monorepo", "",
           "## Conventions", "",
           "- The number at the start of each card title is \"epic.row\" (for example, 4.5 means epic 4, card 5).",
           "- Dependencies are recorded in DiTask's blockedBy field; use it to determine the execution order.",
           f"- Each card has two checklists: \"{ACCEPT_TITLE}\" and \"{DOD_TITLE}\".",
           "- Estimated time = story points × 60 minutes.", "",
           "## Epics", ""]
    out += table(["Number", "Epic"], list(EPICS.items()))
    for si, sp in enumerate(SPRINTS):
        cs = [c for c in all_cards if sprint_of[c["key"]] == si]
        out += ["", f"## {sp['name']}", "",
                f"**Goal:** {sp['goal']}", "",
                f"**Dates:** {sp['start']} to {sp['end']} · **Cards:** {len(cs)} · "
                f"**Story points:** {sum(c['sp'] for c in cs)}", ""]
        out += table(["#", "Title", "Type", "Priority", "SP", "Dependencies"],
                     [[c["key"], c["title"], TYPE_EN[c["type"]], PRIORITY_EN[c["prio"]], c["sp"],
                       ", ".join(c["deps"]) or "—"] for c in cs])
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    main()
