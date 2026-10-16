"""Tools the agent can call. Each tool is a JSON schema (what the model sees) plus a Python
function(args, ctx) -> dict (what actually runs). Every tool acts only on the logged-in
user's own data via ctx.owner.

Add a new tool by writing a function and registering it in TOOLS at the bottom.
"""
import ast
import logging
import math
import operator
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy.orm import Session

from db import Item, Reminder, now

log = logging.getLogger("lizzie.tools")

DEFAULT_TZ = os.environ.get("BOT_TIMEZONE") or "Asia/Kolkata"
HTTP_TIMEOUT = 8.0
CONFIRM_RE = re.compile(r"\b(yes|yeah|yep|yup|confirm|confirmed|sure|go ahead|do it|proceed|delete it)\b", re.I)


@dataclass
class Ctx:
    db: Session
    owner: str
    tz: str = ""            # browser's IANA timezone
    user_message: str = ""  # the user's latest message (used to verify confirmations)


def _zone(name: str):
    for n in (name, DEFAULT_TZ):
        try:
            if n:
                return ZoneInfo(n)
        except Exception:
            continue
    return timezone.utc


def _clip(s, n=300):
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


# ---------- time ---------------------------------------------------------------
def get_datetime(a, ctx):
    zone = _zone(ctx.tz)
    t = datetime.now(zone)
    return {"now": t.strftime("%Y-%m-%d %H:%M"), "weekday": t.strftime("%A"), "timezone": str(zone)}


# ---------- calculator (safe: no eval) -------------------------------------------
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow}
_FUNCS = {"sqrt": math.sqrt, "sin": math.sin, "cos": math.cos, "tan": math.tan, "log": math.log,
          "log10": math.log10, "abs": abs, "round": round, "floor": math.floor, "ceil": math.ceil}
_CONSTS = {"pi": math.pi, "e": math.e}


def _ev(n):
    if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool):
        return n.value
    if isinstance(n, ast.Name) and n.id in _CONSTS:
        return _CONSTS[n.id]
    if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.USub, ast.UAdd)):
        v = _ev(n.operand)
        return -v if isinstance(n.op, ast.USub) else v
    if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
        left, right = _ev(n.left), _ev(n.right)
        if isinstance(n.op, ast.Pow) and abs(right) > 1000:
            raise ValueError("exponent too large")
        return _OPS[type(n.op)](left, right)
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in _FUNCS and not n.keywords:
        return _FUNCS[n.func.id](*[_ev(x) for x in n.args][:2])
    raise ValueError("unsupported expression")


def calculate(a, ctx):
    expr = str(a.get("expression", "")).strip()[:200].replace("^", "**")
    if not expr:
        return {"error": "expression is required"}
    try:
        v = _ev(ast.parse(expr, mode="eval").body)
    except ZeroDivisionError:
        return {"error": "division by zero"}
    except Exception:
        return {"error": "I can't evaluate that expression"}
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
        v = int(v)
    return {"result": v}


# ---------- weather (Open-Meteo: free, no key) -------------------------------------
_WMO = {0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog",
        51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
        71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "heavy rain showers",
        82: "violent rain showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm"}


def get_weather(a, ctx):
    city = str(a.get("city", "")).strip()[:80]
    if not city:
        return {"error": "city is required"}
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as c:
            geo = c.get("https://geocoding-api.open-meteo.com/v1/search", params={"name": city, "count": 1}).json()
            if not geo.get("results"):
                return {"error": f"I couldn't find a place called {city}"}
            p = geo["results"][0]
            w = c.get("https://api.open-meteo.com/v1/forecast", params={
                "latitude": p["latitude"], "longitude": p["longitude"], "timezone": "auto", "forecast_days": 3,
                "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
            }).json()
        cur, day = w["current"], w["daily"]
        return {
            "place": ", ".join(x for x in (p.get("name"), p.get("admin1"), p.get("country")) if x),
            "now": {"temp_c": cur["temperature_2m"], "feels_like_c": cur["apparent_temperature"],
                    "humidity_pct": cur["relative_humidity_2m"], "wind_kmh": cur["wind_speed_10m"],
                    "conditions": _WMO.get(cur["weather_code"], "unknown")},
            "next_days": [{"date": day["time"][i], "high_c": day["temperature_2m_max"][i],
                           "low_c": day["temperature_2m_min"][i], "rain_chance_pct": day["precipitation_probability_max"][i],
                           "conditions": _WMO.get(day["weather_code"][i], "unknown")} for i in range(len(day["time"]))],
        }
    except (httpx.HTTPError, KeyError, ValueError):
        log.exception("weather lookup failed")
        return {"error": "The weather service isn't reachable right now"}


# ---------- web search (Tavily; only enabled when TAVILY_API_KEY is set) -------------
def web_search(a, ctx):
    query = str(a.get("query", "")).strip()[:300]
    if not query:
        return {"error": "query is required"}
    try:
        r = httpx.post("https://api.tavily.com/search", timeout=15.0,
                       headers={"Authorization": f"Bearer {os.environ.get('TAVILY_API_KEY', '')}"},
                       json={"query": query, "max_results": 5, "include_answer": True})
        r.raise_for_status()
        d = r.json()
    except (httpx.HTTPError, ValueError):
        log.exception("web search failed")
        return {"error": "Web search isn't available right now"}
    return {"answer": _clip(d.get("answer") or "", 600),
            "results": [{"title": _clip(x.get("title", ""), 120), "url": x.get("url", ""),
                         "snippet": _clip(x.get("content", ""), 400)} for x in (d.get("results") or [])[:5]]}


# ---------- notes & tasks ----------------------------------------------------------
def _find(db: Session, model, owner: str, prefix):
    prefix = re.sub(r"[^0-9a-f]", "", str(prefix or "").lower())
    if len(prefix) < 4:
        return None
    rows = db.query(model).filter(model.owner == owner, model.id.like(prefix + "%")).limit(2).all()
    return rows[0] if len(rows) == 1 else None


def add_item(a, ctx):
    kind = "task" if str(a.get("kind", "note")).lower() == "task" else "note"
    text = str(a.get("text", "")).strip()[:2000]
    if not text:
        return {"error": "text is required"}
    it = Item(owner=ctx.owner, kind=kind, text=text)
    ctx.db.add(it)
    ctx.db.commit()
    return {"ok": True, "id": it.id[:8], "kind": kind, "text": _clip(text)}


def list_items(a, ctx):
    q = ctx.db.query(Item).filter(Item.owner == ctx.owner)
    kind = str(a.get("kind", "")).lower()
    if kind in ("note", "task"):
        q = q.filter(Item.kind == kind)
    if not a.get("include_done"):
        q = q.filter(Item.done.is_(False))
    rows = q.order_by(Item.created_at.desc()).limit(30).all()
    return {"items": [{"id": r.id[:8], "kind": r.kind, "text": _clip(r.text), "done": r.done} for r in rows]}


def complete_item(a, ctx):
    it = _find(ctx.db, Item, ctx.owner, a.get("id"))
    if not it:
        return {"error": "No single item matches that id. List items first."}
    it.done = bool(a.get("done", True))
    ctx.db.commit()
    return {"ok": True, "id": it.id[:8], "done": it.done}


def delete_item(a, ctx):
    it = _find(ctx.db, Item, ctx.owner, a.get("id"))
    if not it:
        return {"error": "No single item matches that id. List items first."}
    # Server-side guard: the user's own latest message must contain a clear yes.
    if not (a.get("confirmed") and CONFIRM_RE.search(ctx.user_message or "")):
        return {"needs_confirmation": True,
                "instruction": f"Ask the user to confirm deleting this {it.kind}: \"{_clip(it.text, 120)}\". Do not delete yet."}
    ctx.db.delete(it)
    ctx.db.commit()
    return {"ok": True, "deleted": it.id[:8]}


# ---------- reminders ----------------------------------------------------------------
def set_reminder(a, ctx):
    text = str(a.get("text", "")).strip()[:500]
    if not text:
        return {"error": "text is required"}
    zone = _zone(ctx.tz)
    try:
        if a.get("minutes_from_now") is not None:
            mins = float(a["minutes_from_now"])
            if not 0 <= mins <= 60 * 24 * 365:
                return {"error": "that delay is out of range"}
            due = now() + timedelta(minutes=mins)
        elif a.get("at"):
            dt = datetime.fromisoformat(str(a["at"]).strip().replace("Z", "+00:00"))
            due = (dt if dt.tzinfo else dt.replace(tzinfo=zone)).astimezone(timezone.utc)
        else:
            return {"error": "give either minutes_from_now or at"}
    except (ValueError, TypeError):
        return {"error": "I couldn't understand that time"}
    if due < now() - timedelta(seconds=60):
        return {"error": "that time is already in the past"}
    r = Reminder(owner=ctx.owner, text=text, due_at=due)
    ctx.db.add(r)
    ctx.db.commit()
    return {"ok": True, "id": r.id[:8], "text": text, "due": due.astimezone(zone).strftime("%a %d %b, %I:%M %p")}


def list_reminders(a, ctx):
    zone = _zone(ctx.tz)
    rows = (ctx.db.query(Reminder).filter(Reminder.owner == ctx.owner, Reminder.notified.is_(False))
            .order_by(Reminder.due_at).limit(30).all())
    return {"reminders": [{"id": r.id[:8], "text": _clip(r.text),
                           "due": (r.due_at if r.due_at.tzinfo else r.due_at.replace(tzinfo=timezone.utc))
                           .astimezone(zone).strftime("%a %d %b, %I:%M %p")} for r in rows]}


def cancel_reminder(a, ctx):
    r = _find(ctx.db, Reminder, ctx.owner, a.get("id"))
    if not r:
        return {"error": "No single reminder matches that id. List reminders first."}
    ctx.db.delete(r)
    ctx.db.commit()
    return {"ok": True}


# ---------- registry -----------------------------------------------------------------
def _spec(name, description, props=None, required=None):
    return {"type": "function", "function": {"name": name, "description": description, "parameters": {
        "type": "object", "properties": props or {}, "required": required or []}}}


_S, _N, _B = {"type": "string"}, {"type": "number"}, {"type": "boolean"}

TOOLS = {
    "get_datetime": (_spec("get_datetime", "Get the user's current local date, time and weekday."), get_datetime),
    "calculate": (_spec("calculate", "Evaluate a math expression exactly (+ - * / ** %, sqrt, sin, cos, log, pi...).",
                        {"expression": _S}, ["expression"]), calculate),
    "get_weather": (_spec("get_weather", "Current weather and a 3-day forecast for a city.",
                          {"city": _S}, ["city"]), get_weather),
    "web_search": (_spec("web_search", "Search the web for current facts, news or anything you don't know.",
                         {"query": _S}, ["query"]), web_search),
    "add_item": (_spec("add_item", "Save a note or a to-do task for the user.",
                       {"kind": {"type": "string", "enum": ["note", "task"]}, "text": _S}, ["text"]), add_item),
    "list_items": (_spec("list_items", "List the user's saved notes and/or tasks (ids are short prefixes).",
                         {"kind": {"type": "string", "enum": ["note", "task"]}, "include_done": _B}), list_items),
    "complete_item": (_spec("complete_item", "Mark a task/note done (or not done) by id.",
                            {"id": _S, "done": _B}, ["id"]), complete_item),
    "delete_item": (_spec("delete_item", "Delete a note/task by id. Only set confirmed=true after the user has "
                          "explicitly said yes to this specific deletion; otherwise ask them first.",
                          {"id": _S, "confirmed": _B}, ["id"]), delete_item),
    "set_reminder": (_spec("set_reminder", "Set a reminder. Use minutes_from_now for relative times (timers), or "
                           "at as a local 'YYYY-MM-DD HH:MM' for absolute times.",
                           {"text": _S, "minutes_from_now": _N, "at": _S}, ["text"]), set_reminder),
    "list_reminders": (_spec("list_reminders", "List the user's upcoming reminders."), list_reminders),
    "cancel_reminder": (_spec("cancel_reminder", "Cancel an upcoming reminder by id.", {"id": _S}, ["id"]), cancel_reminder),
}


def tool_specs() -> list:
    has_search = bool(os.environ.get("TAVILY_API_KEY"))
    return [spec for name, (spec, _) in TOOLS.items() if name != "web_search" or has_search]


def run_tool(name: str, args: dict, ctx: Ctx) -> dict:
    entry = TOOLS.get(name)
    if not entry or (name == "web_search" and not os.environ.get("TAVILY_API_KEY")):
        return {"error": f"unknown tool {name}"}
    try:
        return entry[1](args if isinstance(args, dict) else {}, ctx)
    except Exception:
        log.exception("tool %s crashed", name)
        ctx.db.rollback()
        return {"error": "that tool failed unexpectedly"}
