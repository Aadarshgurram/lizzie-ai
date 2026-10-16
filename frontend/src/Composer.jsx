import { useEffect, useRef, useState } from "react";
import { BorderBeam } from "border-beam";
import { MetalFx, useMetalBend } from "metal-fx";
import { apiFetch } from "./auth.js";
import { SpeechRec, recogLang } from "./useVoice.js";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export default function Composer({ onSend, busy, apiBase, theme, onMicHold }) {
  const [value, setValue] = useState("");
  const [attachment, setAttachment] = useState(null); // { path, type, name, previewUrl }
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState("");
  const textRef = useRef(null);
  const fileRef = useRef(null);
  const sendRef = useRef(null);
  const mediaRef = useRef(null);
  const stopTimerRef = useRef(null);
  const chunksRef = useRef([]);
  const speechRef = useRef(null);
  const baseRef = useRef("");

  function showError(msg, ms = 8000) {
    setMicError(msg);
    setTimeout(() => setMicError(""), ms);
  }

  useMetalBend(sendRef);

  useEffect(() => {
    const el = textRef.current;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [value]);

  function submit() {
    if ((!value.trim() && !attachment) || busy || uploading) return;
    onSend(value, attachment ? { path: attachment.path, type: attachment.type } : undefined);
    setValue("");
    clearAttachment();
  }

  function clearAttachment() {
    if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    setAttachment(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch(`${apiBase}/upload`, { method: "POST", body: form });
      if (!res.ok) throw new Error(res.status);
      const d = await res.json();
      const isImage = d.type === "image" || IMAGE_EXT.test(file.name);
      setAttachment({
        path: d.path,
        type: isImage ? "image" : "file",
        name: d.name || file.name,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
      });
    } catch {
      setMicError("Couldn't upload that file. Images, PDF, TXT, MD and DOC/DOCX up to 15 MB are supported.");
      setTimeout(() => setMicError(""), 4000);
    } finally {
      setUploading(false);
    }
  }

  // Preferred: live dictation with the browser's speech recognition. Words appear in the box as
  // you speak. If the speech service is unreachable, fall back to recording + server transcription.
  function startSpeech() {
    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = recogLang();
    baseRef.current = value;
    let problem = "";
    rec.onresult = (ev) => {
      const text = Array.from(ev.results).map((r) => r[0].transcript).join(" ").replace(/\s+/g, " ").trim();
      setValue(baseRef.current ? `${baseRef.current} ${text}` : text);
    };
    rec.onerror = (e) => {
      if (["network", "language-not-supported", "not-allowed", "service-not-allowed", "audio-capture"].includes(e.error)) {
        problem = e.error;
      }
    };
    rec.onend = () => {
      speechRef.current = null;
      clearTimeout(stopTimerRef.current);
      setRecording(false);
      if (problem === "network" || problem === "language-not-supported") {
        startRecorder(); // speech service unavailable: record and transcribe on the server instead
        return;
      }
      onMicHold?.(false);
      if (problem === "audio-capture") showError("No microphone was found.");
      else if (problem) showError("Microphone access is blocked. Click the lock icon next to the address bar and allow it.");
    };
    rec.start(); // throws if the browser refuses; the caller falls back to the recorder
    speechRef.current = rec;
    setRecording(true);
    stopTimerRef.current = setTimeout(() => {
      try {
        rec.stop();
      } catch {}
    }, 120000);
  }

  async function toggleRecording() {
    if (starting) return; // ignore a second click while the permission prompt is still pending
    if (recording) {
      try {
        if (speechRef.current) speechRef.current.stop();
        else mediaRef.current?.stop();
      } catch {}
      return;
    }
    setMicError("");
    setStarting(true);
    try {
      onMicHold?.(true); // pause "Hey Lizzie" listening: only one thing can use the mic at a time
      if (SpeechRec) {
        await new Promise((r) => setTimeout(r, 250)); // give the wake-word listener time to let go
        try {
          startSpeech();
        } catch {
          await startRecorder();
        }
      } else {
        await startRecorder();
      }
    } finally {
      setStarting(false);
    }
  }

  async function startRecorder() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        clearTimeout(stopTimerRef.current);
        setRecording(false);
        onMicHold?.(false);
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (blob.size < 500) return; // too short, ignore
        setTranscribing(true);
        try {
          const form = new FormData();
          form.append("file", blob, "speech.webm");
          const res = await apiFetch(`${apiBase}/transcribe`, { method: "POST", body: form });
          if (!res.ok) {
            let detail = "";
            try {
              detail = (await res.json()).detail || "";
            } catch {}
            throw new Error(detail || `HTTP ${res.status}`);
          }
          const d = await res.json();
          if (!d.text) showError("I couldn't hear any speech. Try again a little closer to the mic.");
          if (d.text) setValue((v) => (v ? `${v} ${d.text}` : d.text));
        } catch (err) {
          showError(`Transcription failed: ${String(err.message || err).slice(0, 200)}`);
        } finally {
          setTranscribing(false);
        }
      };
      mediaRef.current = rec;
      rec.start();
      setRecording(true);
      // Safety net: auto-stop after 2 minutes so a stuck mic can never record forever.
      stopTimerRef.current = setTimeout(() => {
        try {
          rec.stop();
        } catch {}
      }, 120000);
    } catch {
      onMicHold?.(false);
      showError("Microphone access was blocked or unavailable. Click the lock icon next to the address bar and allow it.");
    }
  }

  useEffect(
    () => () => {
      clearTimeout(stopTimerRef.current);
      try {
        speechRef.current?.abort();
      } catch {}
      if (mediaRef.current && mediaRef.current.state !== "inactive") mediaRef.current.stop();
    },
    []
  );

  const busyState = busy || uploading || transcribing;

  return (
    <footer className="dock">
      <div className="wrap">
        {attachment && (
          <div className="attach-preview">
            {attachment.previewUrl ? (
              <img src={attachment.previewUrl} alt="" />
            ) : (
              <span className="attach-file">📎 {attachment.name}</span>
            )}
            <button className="ghost icon-btn" onClick={clearAttachment} aria-label="Remove attachment">✕</button>
          </div>
        )}
        {micError && <p className="mic-error">{micError}</p>}
        <BorderBeam
          size="md"
          colorVariant="colorful"
          strength={1}
          brightness={2.2}
          saturation={1.8}
          hueRange={60}
          duration={1.4}
          theme={theme}
          active={!busyState}
        >
        <form
          className={`box${recording ? " listening" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {(recording || transcribing) && (
            <div className="rec-row" role="status">
              {transcribing ? (
                <span className="mic-spinner" />
              ) : (
                <span className="wave" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              )}
              <span>{transcribing ? "Transcribing…" : "Listening… speak now, tap Stop when you're done"}</span>
            </div>
          )}
          <input ref={fileRef} type="file" hidden accept="image/*,.pdf,.txt,.md,.doc,.docx" onChange={handleFile} />
          <textarea
            ref={textRef}
            rows={1}
            value={value}
            placeholder={recording ? "Listening…" : "Ask anything…"}
            aria-label="Message"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="box-row">
            <div className="box-row-left">
              <MetalFx preset="chromatic" variant="button" strength={1} innerShadow ringCssPx={2.5} shaderScale={2.2} scale={1.15} theme={theme}>
                <button
                  type="button"
                  className="pill-btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={busyState}
                  aria-label="Attach a file or image"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05 12.5 20a4.5 4.5 0 0 1-6.36-6.36l8.49-8.49a3 3 0 0 1 4.24 4.24l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.07-7.07" /></svg>
                  Attach
                </button>
              </MetalFx>
              <MetalFx preset="chromatic" variant="button" strength={1} innerShadow ringCssPx={2.5} shaderScale={2.2} scale={1.15} theme={theme}>
                <button
                  type="button"
                  className={`pill-btn${recording ? " live" : ""}`}
                  onClick={toggleRecording}
                  disabled={busy || uploading || starting || transcribing}
                  aria-label={recording ? "Stop recording" : "Record a voice message"}
                >
                  {transcribing ? (
                    <span className="mic-spinner" />
                  ) : (
                    <>
                      {recording && <span className="rec-dot" />}
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" /><path d="M19 11a7 7 0 0 1-14 0M12 19v3" /></svg>
                    </>
                  )}
                  {recording ? "Stop" : starting ? "Starting…" : transcribing ? "Transcribing…" : "Voice"}
                </button>
              </MetalFx>
            </div>
            <MetalFx preset="chromatic" variant="circle" innerShadow strength={1} ringCssPx={3} shaderScale={1.8} scale={1.2} theme={theme} ref={sendRef}>
              <button className="send" type="submit" disabled={(!value.trim() && !attachment) || busyState} aria-label="Send message">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
            </MetalFx>
          </div>
        </form>
        </BorderBeam>
        <p className="hint">Lizzie is AI and can make mistakes. Please double-check responses.</p>
      </div>
    </footer>
  );
}
