"""Local speech-to-text using faster-whisper (CPU-friendly, no API calls).
The first transcription downloads the model once and caches it.

faster-whisper is imported lazily, so the server still boots (and everything
else keeps working) if it isn't installed or the host is short on RAM.

Pick the size with the WHISPER_MODEL env var: tiny | base | small | medium.
Bigger = slower + more accurate + more memory. "base" is a safe default for a
small hosted instance; use "tiny" on a 512 MB free tier, "small" locally.
"""
import os
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()  # reads backend/.env if present

MODEL_SIZE = os.environ.get("WHISPER_MODEL") or "base"


@lru_cache(maxsize=1)
def _model():
    from faster_whisper import WhisperModel  # lazy: heavy import

    return WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")


def transcribe(audio_path: str) -> str:
    segments, _ = _model().transcribe(audio_path, beam_size=1)
    return " ".join(s.text.strip() for s in segments).strip()
