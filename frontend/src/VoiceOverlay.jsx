import { useEffect } from "react";

// Full-screen popup shown while Lizzie is listening / thinking / answering by voice.
// stage: "listening" | "thinking" | "reply" | "error"
const TITLES = { listening: "Listening…", thinking: "Thinking…", reply: "Lizzie", error: "Something went wrong" };

export default function VoiceOverlay({ stage, heard, reply, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="vo" role="dialog" aria-live="polite" aria-label="Lizzie voice assistant" onClick={onClose}>
      <div className={`vo-card ${stage}`} onClick={(e) => e.stopPropagation()}>
        <div className="vo-orb" aria-hidden="true">
          <i />
          <i />
          <i />
          <b />
        </div>
        <p className="vo-title">{TITLES[stage]}</p>
        {stage === "listening" && <p className="vo-text">{heard || "Go ahead, I'm listening"}</p>}
        {stage === "thinking" && <p className="vo-text">{heard}</p>}
        {stage === "reply" && (
          <>
            {heard && <p className="vo-heard">“{heard}”</p>}
            <p className="vo-text vo-reply">{reply}</p>
          </>
        )}
        {stage === "error" && <p className="vo-text">I couldn't get an answer. Please try again.</p>}
        <button className="vo-close" onClick={onClose}>
          {stage === "listening" ? "Cancel" : "Close"}
        </button>
      </div>
    </div>
  );
}
