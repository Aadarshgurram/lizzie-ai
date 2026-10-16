"""Fast dev launcher — NO auto-reload, so nothing watches the filesystem at all.
Starts in well under a second once the venv is outside backend/ (see below).
Use this for day-to-day chatting with the bot.

Editing backend code? Stop this (Ctrl+C) and use reload_run.py instead, which
restarts automatically on save but is a bit slower to boot.

Run: py fast_run.py
"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)
