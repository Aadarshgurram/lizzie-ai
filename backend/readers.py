"""Extract plain text from files the user uploaded, so the assistant can read them."""
import logging
from pathlib import Path

log = logging.getLogger("lizzie.readers")

MAX_CHARS = 12000  # keeps the prompt small enough for the model's context


def extract_text(path: Path, limit: int = MAX_CHARS) -> str:
    """Returns "" when the file is missing, unreadable, scanned/empty, or an unsupported type."""
    try:
        ext = path.suffix.lower()
        if ext in (".txt", ".md"):
            text = path.read_text(encoding="utf-8", errors="replace")
        elif ext == ".pdf":
            from pypdf import PdfReader  # lazy: only needed when a PDF is attached

            text = "\n".join((p.extract_text() or "") for p in PdfReader(str(path)).pages[:30])
        elif ext == ".docx":
            import docx  # python-docx

            text = "\n".join(p.text for p in docx.Document(str(path)).paragraphs)
        else:
            return ""
        return text.strip()[:limit]
    except Exception:
        log.exception("could not read %s", path.name)
        return ""
