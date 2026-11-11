#!/usr/bin/env python3
"""ساخت فایل برد دی‌تسک (فرمت dikar.board نسخهٔ ۱) و خلاصهٔ Markdown از روی cards_*.py.

اجرا (از پوشهٔ docs):  python3 tools/board/build_board.py
خروجی: board/dirouter-board.json و board/README.md
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
    ("گیت‌وی", "#0ea5e9"),
    ("کنترل‌پنل-API", "#6366f1"),
    ("داشبورد", "#ec4899"),
    ("زیرساخت-داکر", "#64748b"),
    ("دیتابیس", "#8b5cf6"),
    ("تاب‌آوری", "#f97316"),
    ("امنیت", "#dc2626"),
    ("تست", "#14b8a6"),
    ("مستندات", "#10b981"),
    ("صورت‌حساب", "#eab308"),
    ("ایجنت-MCP", "#a855f7"),
    ("ارزش بالا", "#ef4444"),
]
LABEL_INDEX = {name: i for i, (name, _) in enumerate(LABELS)}

SPRINTS = [
    dict(name="اسپرینت ۱ — MVP: گیت‌وی تاب‌آور، داکر، Traefik و داشبورد پایه",
         goal="یک گیت‌وی end-to-end پشت Traefik که درخواست OpenAI و Anthropic را با فال‌بک، circuit breaker، rate limit، بودجه و حسابداری به چند provider می‌رساند؛ داشبورد فارسی پایه؛ کاملاً داکرایز و مستند.",
         status="ACTIVE", start="2026-11-07", end="2026-11-20", rank="i", cards=S1),
    dict(name="اسپرینت ۲ — v1: تاب‌آوری پیشرفته، امنیت سازمانی، کش و آنالیتیکس",
         goal="استراتژی‌های هوشمند مسیریابی و hedging، کش و فشرده‌سازی، MFA و SSO و audit، guardrail، هشدار، داشبورد تحلیلی، config نسخه‌دار و استقرار HA با تست chaos.",
         status="PLANNED", start="2026-11-21", end="2026-12-04", rank="r", cards=S2),
    dict(name="اسپرینت ۳ — صورت‌حساب، ایجنت/MCP و انتشار v1.0",
         goal="کیف پول و درگاه پرداخت و پرتال فروش، MCP gateway و A2A، مسیریابی classifier، چندرسانه‌ای، SAML/SCIM، امنیت زنجیرهٔ تأمین، benchmark و انتشار v1.0.",
         status="PLANNED", start="2026-12-05", end="2026-12-18", rank="v", cards=S3),
]

LISTS = [("📥 بک‌لاگ", "i"), ("🔎 آماده برای شروع", "r"), ("🛠 در حال انجام", "v"),
         ("👀 بازبینی", "x"), ("✅ انجام‌شده", "y")]

DOD = ["تست‌های واحد/یکپارچهٔ مرتبط نوشته شده و در CI سبز است",
       "مستندات مرتبط در docs/ به‌روزرسانی شده (فارسی)",
       "در محیط docker compose اجرا و بررسی شده",
       "بازبینی کد انجام و تأیید شده"]

FA_DIGITS = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")
PRIORITY_FA = {"URGENT": "فوری", "HIGH": "بالا", "MEDIUM": "متوسط", "LOW": "پایین"}
TYPE_FA = {"STORY": "استوری", "TASK": "تسک", "BUG": "باگ"}


def fa(s: str) -> str:
    return s.translate(FA_DIGITS)


def rank(i: int, n: int) -> str:
    """رتبهٔ رشته‌ای مرتب‌شونده (دو حرف a-z) با فاصلهٔ یکنواخت برای درج‌های بعدی."""
    v = (i + 1) * 676 // (n + 1)
    return chr(97 + v // 26) + chr(97 + v % 26)


def ref_for(key: str) -> str:
    return "cdr" + hashlib.sha1(f"dirouter:{key}".encode()).hexdigest()[:22]


def iso(day: str, end: bool = False) -> str:
    return f"{day}T23:59:59.000Z" if end else f"{day}T00:00:00.000Z"


def describe(c: dict, by_key: dict) -> str:
    parts = [f"## 🎯 هدف\n{c['goal']}", f"## 📋 شرح کار\n{c['work']}",
             "## ✅ معیار پذیرش\n" + "\n".join(f"- [ ] {a}" for a in c["accept"])]
    if c["tech"]:
        parts.append(f"## 🔧 یادداشت فنی\n{c['tech']}")
    if c["deps"]:
        parts.append("## 🔗 وابستگی‌ها\n" + "\n".join(
            f"- {fa(d)} {by_key[d]['title']}" for d in c["deps"]))
    parts.append("## 🏁 تعریف انجام (DoD)\n" + "\n".join(f"- [ ] {d}" for d in DOD))
    return "\n\n".join(parts)


def checklist(title: str, items: list) -> dict:
    return {"title": title, "rank": "i" if title == "معیار پذیرش" else "r",
            "items": [{"text": t, "done": False, "rank": rank(i, len(items)), "dueDate": None}
                      for i, t in enumerate(items)]}


def validate(all_cards: list, sprint_of: dict) -> None:
    keys = [c["key"] for c in all_cards]
    dupes = {k for k in keys if keys.count(k) > 1}
    assert not dupes, f"کلید تکراری: {dupes}"
    by_key = {c["key"]: c for c in all_cards}
    for c in all_cards:
        for lab in c["labels"]:
            assert lab in LABEL_INDEX, f"{c['key']}: برچسب ناشناخته {lab}"
        assert c["prio"] in PRIORITY_FA and c["type"] in TYPE_FA, c["key"]
        for d in c["deps"]:
            assert d in by_key, f"{c['key']}: وابستگی ناموجود {d}"
            assert sprint_of[d] <= sprint_of[c["key"]], \
                f"{c['key']} به {d} از اسپرینت بعدی وابسته است"
    # cycle detection
    state = {}

    def visit(k, path):
        if state.get(k) == 1:
            raise AssertionError("چرخهٔ وابستگی: " + " → ".join(path + [k]))
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
            "title": f"{fa(c['key'])} {c['title']}",
            "description": describe(c, by_key),
            "rank": rank(n - 1, len(all_cards)),
            "dueDate": iso(sp["end"]), "startDate": None, "completed": False, "coverColor": None,
            "estimateMinutes": c["sp"] * 60, "storyPoints": c["sp"],
            "priority": c["prio"], "cardType": c["type"],
            "sprintRef": sprint_of[c["key"]], "epicRef": None,
            "blockedBy": [ref_for(d) for d in c["deps"]], "archived": False,
            "labels": [LABEL_INDEX[lab] for lab in c["labels"]],
            "checklists": [checklist("معیار پذیرش", c["accept"]), checklist("تعریف انجام (DoD)", DOD)],
            "fieldValues": [], "worklogs": [],
        })

    board = {
        "type": "dikar.board", "version": 1,
        "exportedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "board": {
            "title": "🧭 DiRouter — گیت‌وی هوشمند LLM",
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

    for si, sp in enumerate(SPRINTS):
        cs = sp["cards"]
        print(f"{sp['name']}: {len(cs)} کارت، {sum(c['sp'] for c in cs)} استوری‌پوینت")
    print(f"جمع: {len(all_cards)} کارت → {OUT_DIR / 'dirouter-board.json'}")


def summary_md(all_cards: list, sprint_of: dict) -> str:
    out = ["# برد DiRouter (دی‌تسک)", "",
           "> این فایل خودکار از `tools/board/build_board.py` ساخته می‌شود؛ دستی ویرایش نکنید.", "",
           "## ورود به دی‌تسک",
           "فایل `docs/board/dirouter-board.json` را از بخش «انتقال اطلاعات / ورود برد» در دی‌تسک وارد کنید. "
           "همهٔ کارت‌ها در لیست «📥 بک‌لاگ» قرار دارند و به اسپرینت خود متصل‌اند؛ اسپرینت ۱ فعال است.", "",
           "## پشتهٔ فنی",
           "- **Backend:** NestJS (روی Fastify adapter) برای gateway، control-api و worker",
           "- **Frontend:** React + Vite + TypeScript، TanStack Router/Query، shadcn/ui، Tailwind (RTL)",
           "- **دیتابیس:** PostgreSQL 17 + Prisma (لاگ‌ها پارتیشن‌بندی‌شده + جداول تجمیعی)",
           "- **شمارنده، کش، pub/sub و صف:** Valkey + BullMQ",
           "- **ریورس پراکسی:** Traefik v3 (TLS با Let's Encrypt، پشتیبانی SSE)",
           "- **استقرار:** Docker و docker compose (dev، prod، HA)؛ مونوریپو pnpm + Turborepo", "",
           "## قراردادها",
           "- شمارهٔ ابتدای عنوان هر کارت = «اپیک.ردیف» (مثلاً ۴.۵ یعنی اپیک ۴، کارت ۵).",
           "- وابستگی‌ها در فیلد blockedBy دی‌تسک ثبت شده‌اند؛ ترتیب اجرا را از آن بگیرید.",
           "- هر کارت دو چک‌لیست دارد: «معیار پذیرش» و «تعریف انجام (DoD)».",
           "- برآورد زمان = استوری‌پوینت × ۶۰ دقیقه.", "",
           "## اپیک‌ها",
           "| شماره | اپیک |", "|---|---|"]
    epics = {
        "0": "معماری و تصمیم‌ها", "1": "مونوریپو و ابزار", "2": "داکر و Traefik",
        "3": "دیتابیس و control-api", "4": "هستهٔ گیت‌وی", "5": "مسیریابی و تاب‌آوری",
        "6": "محدودیت، بودجه و حسابداری", "7": "داشبورد MVP", "8": "Observability",
        "9": "تست و QA", "10": "مستندات MVP", "11": "API و providerهای بیشتر",
        "12": "مسیریابی و تاب‌آوری پیشرفته", "13": "کش و صرفه‌جویی توکن", "14": "امنیت سازمانی",
        "15": "Guardrail", "16": "داشبورد پیشرفته و هشدار", "17": "پیکربندی، tracing و HA",
        "18": "Chaos و مستندات v1", "19": "صورت‌حساب و فروش", "20": "ایجنت، MCP و مسیریابی هوشمند",
        "21": "چندرسانه‌ای و افزونه‌ها", "22": "سازمانی، امنیت و انتشار",
    }
    out += [f"| {fa(k)} | {v} |" for k, v in epics.items()]
    for si, sp in enumerate(SPRINTS):
        cs = [c for c in all_cards if sprint_of[c["key"]] == si]
        out += ["", f"## {sp['name']}",
                f"**هدف:** {sp['goal']}", "",
                f"**بازه:** {sp['start']} تا {sp['end']} · **کارت:** {fa(str(len(cs)))} · "
                f"**استوری‌پوینت:** {fa(str(sum(c['sp'] for c in cs)))}", "",
                "| # | عنوان | نوع | اولویت | SP | وابستگی |", "|---|---|---|---|---|---|"]
        out += [f"| {fa(c['key'])} | {c['title']} | {TYPE_FA[c['type']]} | {PRIORITY_FA[c['prio']]} | "
                f"{fa(str(c['sp']))} | {fa('، '.join(c['deps'])) or '—'} |" for c in cs]
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    main()
