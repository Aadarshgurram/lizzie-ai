# Deploying Lizzie AI

## Before you push to GitHub
`backend/.env` has a real Groq API key in it. `.gitignore` already excludes it, but
run `git status` before your first commit and make sure `.env` is NOT listed.
If it was ever committed, regenerate the key at console.groq.com/keys.

## Things to know before picking a host

1. **File storage is not persistent on most free hosts.** `chatbot.db` (SQLite) and
   `backend/uploads/` live on local disk, which Render free / Railway wipe on every
   redeploy or restart. For persistent chat history, set `DATABASE_URL` to a hosted
   Postgres (Neon, Supabase, Render Postgres). Both `postgres://` and `postgresql://`
   URLs work. Uploaded files would need object storage to persist; only worth it if needed.

2. **RAM.** spaCy's `md` model plus faster-whisper can be tight on a 512 MB instance.
   If the backend gets OOM-killed after deploy, set `WHISPER_MODEL=tiny`, use a bigger
   instance, or drop voice input.

3. **Cold starts.** Render's free tier sleeps after ~15 min idle and takes ~30-60 s to wake.
   The UI shows "Offline"/"Connecting" and retries on its own every 8 s.

4. **Login.** Only you can use the app. Passwords are stored as scrypt hashes in the database, and
   sessions are random tokens that expire after 30 min idle / 12 h total (`SESSION_IDLE_MINUTES`,
   `SESSION_MAX_HOURS`). The token lives in the browser's sessionStorage, so closing the browser or
   shutting the computer down logs you out. Five wrong passwords from one IP locks that IP out for
   15 minutes. Use a long, unique password. Uploaded files are served from unguessable URLs rather
   than behind the login, so don't share those links.

5. **Cost protection.** `/chat`, `/upload` and `/transcribe` are limited to
   `RATE_LIMIT_PER_MIN` (default 30) requests per minute per IP.

## Recommended free split: Vercel (frontend) + Render (backend)

### Backend -> Render
1. Push the repo to GitHub.
2. New Web Service -> connect repo -> **Root Directory** = `backend`.
3. Build command:
   `pip install -r requirements.txt && python -m spacy download en_core_web_md && python -m nltk.downloader stopwords wordnet omw-1.4`
4. Start command: leave blank (uses `Procfile`) or `uvicorn main:app --host 0.0.0.0 --port $PORT`.
5. Python version comes from `backend/.python-version` (3.11). If your host ignores it, set
   env var `PYTHON_VERSION=3.11.9`.
6. Environment variables (dashboard, not a file):
   - `GROQ_API_KEY`
   - `GROQ_TEXT_MODEL` = `openai/gpt-oss-120b`
   - `GROQ_VISION_MODEL` = a vision model your key can use (run `py check_models.py` locally); leave empty to disable image understanding
   - `CORS_ORIGINS` = your Vercel URL, e.g. `https://your-app.vercel.app` (comma-separate several)
   - `WHISPER_MODEL` = `tiny` on a 512 MB instance
   - `DATABASE_URL` = Postgres URL (optional; unset = SQLite)
   - `ADMIN_USERNAME` and `ADMIN_PASSWORD` = your login (10+ characters). Created on startup; you can
     delete `ADMIN_PASSWORD` afterwards. To change the password later, set it again and redeploy
     (this also logs out every session). Or run `py create_user.py` against the deployed `DATABASE_URL`.
7. Deploy, then open `https://<service>.onrender.com/health`, you should see `{"status":"ok",...}`.

### Frontend -> Vercel
1. New Project -> import the repo -> **Root Directory** = `frontend` (Vite preset).
2. Env var `VITE_API_URL` = your Render URL (no trailing slash, no `/api`).
3. Deploy. Then set `CORS_ORIGINS` on Render to the Vercel URL and redeploy the backend.
   For Vercel preview URLs too, set `CORS_ORIGIN_REGEX`, e.g. `https://your-app(-[a-z0-9-]+)?\.vercel\.app`.

## Assistant features
- **Hey Lizzie / OK Lizzie:** click the 🎙 button in the header, then say the wake phrase followed by your
  command (or pause, wait for the beep, then speak). Needs Chrome/Edge/Safari, mic permission, an open tab,
  and internet (Chrome sends the audio to Google's speech service). 🔊 reads every reply aloud;
  voice commands are always answered aloud.
- **Tools the AI can use:** weather (no key), calculator, current time, notes and tasks, reminders/timers,
  and reading attached PDF/DOCX/TXT/MD files. Web search turns on when `TAVILY_API_KEY` is set
  (free key at tavily.com). Deleting anything needs your explicit "yes".
- **Reminders** are delivered while the app is open (checked every 20 s) as a message, spoken aloud and a
  browser notification if you allow it. A closed tab can't be reached.
- Set `TAVILY_API_KEY` on Render too if you want web search in production.

## Local run
- Backend: `cd backend && py fast_run.py`
- Frontend: `cd frontend && npm install && npm run dev`

## Smoke test (run locally before deploying)
- [ ] Wrong password is rejected; correct one signs in
- [ ] Close the browser, reopen: you're asked to sign in again
- [ ] Plain text message gets an NLP or Groq reply
- [ ] Upload an image and ask about it (needs `GROQ_VISION_MODEL`)
- [ ] Voice message transcribes into the box
- [ ] New chat, switch between chats, delete one
- [ ] Light/dark toggle
- [ ] Refresh lands on a fresh chat
- [ ] Chat order in the sidebar follows latest activity

Note: your existing local `chatbot.db` chats have no owner id, so they won't show in the
sidebar any more. Delete `backend/chatbot.db` for a clean start.
