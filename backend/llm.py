"""Groq-hosted LLM client. Requires GROQ_API_KEY in backend/.env.
Models available depend on your Groq account: run `py check_models.py` to list them.
"""
import base64
import logging
import mimetypes
import os

from dotenv import load_dotenv
from groq import Groq

load_dotenv()  # reads backend/.env if present

log = logging.getLogger("lizzie.llm")

# `or` so an empty value set in a host dashboard falls back to the default.
TEXT_MODEL = os.environ.get("GROQ_TEXT_MODEL") or "openai/gpt-oss-120b"
VISION_MODEL = (os.environ.get("GROQ_VISION_MODEL") or "").strip()  # empty = image understanding disabled
MAX_TOKENS = 2048  # gpt-oss models spend some tokens on reasoning before answering
MAX_IMAGE_BYTES = 3 * 1024 * 1024  # Groq caps base64 image payloads at ~4 MB; base64 adds ~33%

_client = None


def _get_client() -> Groq:
    global _client
    if _client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY is not set (add it to backend/.env)")
        _client = Groq(api_key=api_key)
    return _client


def _status(e: Exception):
    return getattr(e, "status_code", None)


def is_available() -> bool:
    """Config check only (no network call) — true once GROQ_API_KEY is set."""
    return bool(os.environ.get("GROQ_API_KEY"))


def chat(message: str, history: list[dict] | None = None) -> str:
    """history: list of {"role": "user"|"assistant", "content": str}, most recent last."""
    messages = (history or [])[-10:] + [{"role": "user", "content": message}]
    extra = {"reasoning_effort": "low"} if TEXT_MODEL.startswith("openai/gpt-oss") else None
    try:
        client = _get_client()
        resp = client.chat.completions.create(
            model=TEXT_MODEL,
            messages=messages,
            max_tokens=MAX_TOKENS,
            **({"extra_body": extra} if extra else {}),
        )
        text = (resp.choices[0].message.content or "").strip()
        return text or "(The model returned an empty reply — try asking again.)"
    except Exception as e:
        log.exception("Groq text request failed")
        if _status(e) == 429:
            return "I'm getting a lot of requests right now — give it a minute and try again."
        if isinstance(e, RuntimeError):  # missing GROQ_API_KEY
            return "The AI model isn't configured on this server yet."
        return "Sorry, the AI model is unavailable right now. Please try again in a moment."


def describe_image(image_path: str, question: str = "Describe this image.") -> str:
    if not VISION_MODEL:
        return "Image understanding isn't enabled — no vision model is set in GROQ_VISION_MODEL."
    mime, _ = mimetypes.guess_type(image_path)
    mime = mime or "image/jpeg"
    try:
        with open(image_path, "rb") as f:
            raw = f.read()
    except OSError:
        return "I couldn't open that image. Please upload it again."
    if len(raw) > MAX_IMAGE_BYTES:
        return "That image is too large for me to read (about 3 MB max). Try a smaller or compressed version."
    b64 = base64.b64encode(raw).decode()
    data_url = f"data:{mime};base64,{b64}"
    try:
        client = _get_client()
        resp = client.chat.completions.create(
            model=VISION_MODEL,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": question},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }],
            max_tokens=MAX_TOKENS,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as e:
        log.exception("Groq vision request failed")
        if _status(e) == 429:
            return "I'm getting a lot of requests right now — give it a minute and try again."
        if _status(e) in (400, 404):
            return "That vision model isn't available on this Groq account, so I can't read images right now."
        if isinstance(e, RuntimeError):  # missing GROQ_API_KEY
            return "The AI model isn't configured on this server yet."
        return "Sorry, I couldn't read that image right now. Please try again in a moment."
