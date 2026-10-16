"""Dev launcher WITH auto-reload, for when you're actively editing backend code.
Only fast if .venv lives OUTSIDE this backend/ folder — see the note in
fast_run.py / the setup steps you were given for moving it. If .venv is still
inside backend/, use fast_run.py instead and restart it manually after edits.

Run: py reload_run.py
"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
        reload_dirs=["."],
        reload_excludes=[".venv/*", "uploads/*", "__pycache__/*", "*.db", "*.db-journal"],
    )
