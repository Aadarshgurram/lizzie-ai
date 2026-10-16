import { useEffect, useRef, useState } from "react";
import Message from "./Message.jsx";
import Sidebar from "./Sidebar.jsx";
import Composer from "./Composer.jsx";
import { ThinkingOrb } from "thinking-orbs";
import Login from "./Login.jsx";
import { apiFetch, clearToken, getToken } from "./auth.js";
import { useVoice } from "./useVoice.js";
import VoiceOverlay from "./VoiceOverlay.jsx";

// Backend contract:
//   GET    /health                              -> { status, llm_available }
//   GET    /conversations                        -> [{ id, title, updated_at }]
//   POST   /conversations                         -> { id, title }
//   GET    /conversations/{id}/messages           -> [{ id, role, content, source, attachment_path, attachment_type }]
//   DELETE /conversations/{id}
//   POST   /upload        (multipart "file")     -> { path, type: "image"|"file", name }
//   POST   /transcribe    (multipart "file")     -> { text }
//   POST   /chat  { message, conversation_id, attachment_path?, attachment_type? }
//                                                 -> { reply, source: "nlp"|"llm"|"vision"|"fallback", intent, confidence }
// `||` (not `??`) so an empty VITE_API_URL falls back to the dev proxy; trailing slashes are stripped.
const API = (import.meta.env.VITE_API_URL || "/api").replace(/\/+$/, "");
const SUGGESTIONS = ["What can you do?", "Who built you?", "What time is it?", "Tell me a joke"];

const uid = () => crypto.randomUUID?.() ?? String(Date.now() + Math.random());

// Browser notifications for reminders (only used if you allow them).
const askNotify = () => {
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch {}
};
const notify = (body) => {
  try {
    if ("Notification" in window && Notification.permission === "granted") new Notification("Lizzie", { body });
  } catch {}
};
const load = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

// Every request except /health and /auth/login carries the session token (see auth.js).
const JSON_HEADERS = { "Content-Type": "application/json" };

// fetch + JSON that throws (with .status) on any non-2xx, so error bodies never end up in state.
async function getJson(url, opts) {
  const r = await apiFetch(url, opts);
  if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status });
  return r.json();
}

function Chat({ onLogout }) {
  const [conversations, setConversations] = useState([]);
  // Always boot into a fresh, unsaved chat (id === null). We never restore or
  // auto-select the last conversation here; picking one from the sidebar is
  // the only way to reopen it.
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [theme, setTheme] = useState(
    () => load("chat.theme", null) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
  const [sidebarOpen, setSidebarOpen] = useState(() => !matchMedia("(max-width: 760px)").matches);
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState({ status: "checking", llm: false });
  const abort = useRef(null);
  const endRef = useRef(null);

  // Voice: "Hey Lizzie" wake word + spoken replies (see useVoice.js).
  const [speakReplies, setSpeakReplies] = useState(() => load("chat.speak", false));
  const [voiceTask, setVoiceTask] = useState(null); // voice command in progress: { text, stage, reply }
  const sendRef = useRef(null);
  const voice = useVoice({
    onCommand: (t) => {
      setVoiceTask({ text: t, stage: "thinking", reply: "" });
      sendRef.current?.(t, undefined, { viaVoice: true });
    },
  });
  sendRef.current = send; // always the latest send(), so voice commands never use stale state
  useEffect(() => save("chat.speak", speakReplies), [speakReplies]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    save("chat.theme", theme);
  }, [theme]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, loading]);

  async function checkHealth() {
    try {
      const h = await getJson(`${API}/health`);
      setHealth({ status: "online", llm: !!h.llm_available });
      return true;
    } catch {
      setHealth({ status: "offline", llm: false });
      return false;
    }
  }

  async function refreshConversations() {
    try {
      const data = await getJson(`${API}/conversations`);
      const list = Array.isArray(data) ? data : [];
      setConversations(list);
      return list;
    } catch {
      return [];
    }
  }

  async function loadMessages(id) {
    try {
      const data = await getJson(`${API}/conversations/${id}/messages`);
      setMessages(
        (Array.isArray(data) ? data : []).map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          source: m.source,
          attachment_path: m.attachment_path,
          attachment_type: m.attachment_type,
        }))
      );
    } catch {
      setMessages([]);
    }
  }

  // Reset the view to a blank, unsaved chat. No backend call here — the
  // conversation row is only created lazily, once the user actually sends
  // something (see ensureConversation below). This is what both the "New
  // chat" sidebar button and app boot use, so opening the app never jumps
  // back into an old conversation.
  function startNewChat() {
    setConversationId(null);
    setMessages([]);
    if (matchMedia("(max-width: 760px)").matches) setSidebarOpen(false);
  }

  // Returns the id of a conversation to send into, creating one on the
  // backend first if the current chat hasn't been saved yet.
  async function ensureConversation() {
    if (conversationId) return conversationId;
    const c = await getJson(`${API}/conversations`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "New chat" }),
    });
    setConversations((prev) => [c, ...prev]);
    setConversationId(c.id);
    return c.id;
  }

  // boot: just check the backend and load the conversation list for the
  // sidebar. We deliberately do NOT auto-select or auto-create a
  // conversation here, so the app always opens on a fresh chat.
  useEffect(() => {
    (async () => {
      const ok = await checkHealth();
      if (ok) refreshConversations();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While offline (e.g. a free-tier backend waking up from sleep), keep retrying
  // quietly so the status flips back to Online and the sidebar fills in by itself.
  useEffect(() => {
    if (health.status !== "offline") return;
    const t = setInterval(async () => {
      if (await checkHealth()) refreshConversations();
    }, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health.status]);

  // Reminders: while the app is open, check every 20 s for ones that have come due, then show,
  // speak and (if allowed) notify. A closed tab can't be reached, so those show up on next open.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const due = await getJson(`${API}/reminders/due`);
        for (const r of Array.isArray(due) ? due : []) {
          setMessages((m) => [
            ...m,
            { id: uid(), role: "assistant", content: `⏰ Reminder: ${r.text}`, source: "nlp", fresh: true },
          ]);
          voice.speak(`Reminder: ${r.text}`);
          notify(`Reminder: ${r.text}`);
        }
      } catch {}
    }, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectConversation(id) {
    if (id === conversationId) return;
    setConversationId(id);
    if (matchMedia("(max-width: 760px)").matches) setSidebarOpen(false);
    await loadMessages(id);
  }

  async function deleteConversation(id) {
    await apiFetch(`${API}/conversations/${id}`, { method: "DELETE" }).catch(() => {});
    const remaining = conversations.filter((c) => c.id !== id);
    setConversations(remaining);
    if (id === conversationId) {
      if (remaining.length) {
        setConversationId(remaining[0].id);
        loadMessages(remaining[0].id);
      } else {
        startNewChat();
      }
    }
  }

  async function send(text, attachment, opts) {
    const message = text.trim();
    if ((!message && !attachment) || loading) return;
    setMessages((m) => [
      ...m.filter((x) => !x.error),
      { id: uid(), role: "user", content: message, attachment_path: attachment?.path, attachment_type: attachment?.type },
    ]);
    setLoading(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      // Inside the try so a failure creating the conversation shows the normal error + Retry.
      const id = await ensureConversation();
      const res = await apiFetch(`${API}/chat`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          message,
          conversation_id: id,
          attachment_path: attachment?.path,
          attachment_type: attachment?.type,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw Object.assign(new Error(String(res.status)), { status: res.status });
      const d = await res.json();
      setMessages((m) => [
        ...m,
        { id: uid(), role: "assistant", content: d.reply, source: d.source, intent: d.intent, confidence: d.confidence, fresh: true },
      ]);
      setHealth((h) => ({ ...h, status: "online" }));
      if (opts?.viaVoice || speakReplies) voice.speak(d.reply);
      if (opts?.viaVoice) setVoiceTask({ text: message, stage: "reply", reply: d.reply });
      refreshConversations();
    } catch (e) {
      if (e.name === "AbortError") return;
      if (opts?.viaVoice) {
        voice.speak("Sorry, something went wrong.");
        setVoiceTask((t) => (t ? { ...t, stage: "error" } : t));
      }
      setMessages((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          error: true,
          retryText: message,
          retryAttachment: attachment,
          content:
            e.status === 429
              ? "You're sending messages too quickly. Wait a few seconds and try again."
              : e.status
              ? "Something went wrong on the server. Please try again in a moment."
              : "Can't reach the server right now. If you're running this locally, make sure the backend is started. Otherwise, please try again in a moment.",
        },
      ]);
      // Only a network-level failure (no HTTP status) means the backend is actually unreachable.
      if (!e.status) setHealth((h) => ({ ...h, status: "offline" }));
    } finally {
      if (abort.current === ctrl) {
        abort.current = null;
        setLoading(false);
      }
    }
  }

  // Status text is a plain online/offline readout now — no more "NLP + local
  // model" / "NLP only" wording.
  const status =
    health.status === "checking" ? "Connecting" : health.status === "offline" ? "Offline" : "Online";
  const voiceLine =
    voice.phase === "capturing"
      ? "Listening…"
      : voice.phase === "speaking"
      ? "Speaking…"
      : voice.enabled
      ? `Say “Hey Lizzie”${voice.lastHeard ? ` · heard: “${voice.lastHeard}”` : ""}`
      : "";

  // Voice popup: shown while listening for a command, then while thinking and showing the answer.
  const overlayStage = voice.phase === "capturing" ? "listening" : voiceTask?.stage ?? null;
  function closeOverlay() {
    if (voice.phase === "capturing") voice.cancelCapture();
    voice.stopSpeaking();
    setVoiceTask(null);
  }
  useEffect(() => {
    // Once the answer has been spoken, let the popup fade away by itself.
    if (voiceTask?.stage !== "reply" && voiceTask?.stage !== "error") return;
    if (voice.phase === "speaking") return;
    const t = setTimeout(() => setVoiceTask(null), voiceTask.stage === "error" ? 3000 : 4000);
    return () => clearTimeout(t);
  }, [voiceTask, voice.phase]);

  function toggleVoice() {
    askNotify();
    voice.toggle();
  }
  function toggleSpeak() {
    askNotify();
    if (speakReplies) voice.stopSpeaking();
    setSpeakReplies(!speakReplies);
  }

  return (
    <div className="app">
      {!sidebarOpen && (
        <button
          className="sidebar-fab"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open sidebar"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <line x1="9.5" y1="4" x2="9.5" y2="20" />
          </svg>
        </button>
      )}

      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onCollapse={() => setSidebarOpen(false)}
        conversations={conversations}
        activeId={conversationId}
        onSelect={selectConversation}
        onDelete={deleteConversation}
        onNew={startNewChat}
      />

      <div className="main">
        <header className="bar">
          <div className="wrap bar-in">
            <div className="bar-left">
              <div>
                <h1>Lizzie AI</h1>
                <p className="status">
                  <span className={`dot ${health.status}`} />
                  {voice.notice || voiceLine || status}
                </p>
              </div>
            </div>
            <div className="actions">
              {voice.supported && (
                <>
                  <button
                    className={`ghost voice-btn${voice.enabled ? " on" : ""}`}
                    onClick={toggleVoice}
                    aria-pressed={voice.enabled}
                    title='Hands-free: say "Hey Lizzie" or "OK Lizzie"'
                  >
                    🎙 {voice.enabled ? "Listening" : "Hey Lizzie"}
                  </button>
                  <button
                    className={`ghost voice-btn${speakReplies ? " on" : ""}`}
                    onClick={toggleSpeak}
                    aria-pressed={speakReplies}
                    aria-label="Read replies aloud"
                    title="Read replies aloud"
                  >
                    🔊
                  </button>
                </>
              )}
              <button className="ghost" onClick={onLogout}>
                Log out
              </button>
              <button
                className="theme-toggle"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              >
                {theme === "dark" ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="4.5" />
                    <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </header>

        <main className="scroll">
          <div className="wrap thread" role="log" aria-live="polite">
            {messages.length === 0 && !loading ? (
              <section className="empty">
                <h2>What can I help with?</h2>
                {/* <p>Answers come from a local NLP engine first, with Groq's cloud models handling anything else and image understanding.</p> */}
                <div className="suggest">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </section>
            ) : (
              messages.map((m) => <Message key={m.id} msg={m} apiBase={API} onRetry={(t, a) => send(t, a)} scrollRef={endRef} />)
            )}
            {loading && (
              <div className="msg bot thinking" role="status" aria-label="Assistant is thinking">
                <ThinkingOrb state="composing" size={64} dark={theme === "dark"} />
              </div>
            )}
            <div ref={endRef} />
          </div>
        </main>

        <Composer onSend={send} busy={loading} apiBase={API} theme={theme} onMicHold={voice.suspend} />
        {overlayStage && (
          <VoiceOverlay
            stage={overlayStage}
            heard={overlayStage === "listening" ? voice.heard : voiceTask?.text}
            reply={voiceTask?.reply}
            onClose={closeOverlay}
          />
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken());

  // apiFetch fires this on any 401: idle timeout, expired session, or logout elsewhere.
  useEffect(() => {
    const expired = () => setAuthed(false);
    window.addEventListener("auth-expired", expired);
    return () => window.removeEventListener("auth-expired", expired);
  }, []);

  // The login screen needs the saved theme too (Chat applies it once signed in).
  useEffect(() => {
    document.documentElement.dataset.theme =
      load("chat.theme", null) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, []);

  async function logout() {
    await apiFetch(`${API}/auth/logout`, { method: "POST" }).catch(() => {});
    clearToken();
    setAuthed(false); // unmounts <Chat>, so no conversations stay in memory
  }

  if (!authed) return <Login api={API} onLogin={() => setAuthed(true)} />;
  return <Chat onLogout={logout} />;
}
