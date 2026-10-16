import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

// Wrap tables so wide ones scroll sideways instead of breaking the layout.
const mdComponents = {
  table: ({ node, ...props }) => (
    <div className="table-wrap">
      <table {...props} />
    </div>
  ),
};

export default function Message({ msg, onRetry, apiBase, scrollRef }) {
  const [copied, setCopied] = useState(false);
  const attachUrl = msg.attachment_path
    ? msg.attachment_path.startsWith("http")
      ? msg.attachment_path
      : `${apiBase}${msg.attachment_path}`
    : null;
  const isImage = msg.attachment_type === "image" || (attachUrl && IMAGE_EXT.test(attachUrl));

  // Only a reply we just received (msg.fresh, set once in App.jsx) types itself
  // out — a message reloaded from conversation history renders instantly.
  const shouldType = msg.role === "assistant" && msg.fresh && !msg.error;
  const [display, setDisplay] = useState(shouldType ? "" : msg.content);
  const [done, setDone] = useState(!shouldType);
  const tickRef = useRef(0);

  useEffect(() => {
    if (!shouldType) {
      setDisplay(msg.content);
      setDone(true);
      return;
    }
    const full = msg.content || "";
    // Finish in ~110 ticks regardless of length, so a one-line reply and a
    // long one both take a similar, snappy amount of time to type out.
    const step = Math.max(1, Math.round(full.length / 110));
    const id = setInterval(() => {
      tickRef.current += step;
      if (tickRef.current >= full.length) {
        setDisplay(full);
        setDone(true);
        clearInterval(id);
      } else {
        setDisplay(full.slice(0, tickRef.current));
        tickRef.current % 3 === 0 && scrollRef?.current?.scrollIntoView({ block: "end" });
      }
    }, 15);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg.id]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  if (msg.role === "user") {
    return (
      <div className="msg user">
        {attachUrl && (
          <div className="attach-sent">
            {isImage ? <img src={attachUrl} alt="Attachment" /> : <a href={attachUrl} target="_blank" rel="noreferrer">📎 Attached file</a>}
          </div>
        )}
        {msg.content && <div className="bubble">{msg.content}</div>}
        {msg.content && (
          <button className="ghost user-copy" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`msg bot${msg.error ? " error" : ""}`}>
      <div className="body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {display}
        </ReactMarkdown>
        {!done && <span className="type-cursor" />}
      </div>
      {done && (
        <div className="meta">
          {msg.source === "nlp" && msg.intent && (
            <span className="trace">
              Intent <b>{msg.intent}</b>
            </span>
          )}
          {msg.source === "llm" && (
            <span className="trace">
              Answered by <b>Groq</b>
            </span>
          )}
          {msg.source === "vision" && (
            <span className="trace">
              Answered by <b>vision model</b>
            </span>
          )}
          {msg.source === "fallback" && <span className="trace warn">No intent matched</span>}
          {msg.error ? (
            <button className="ghost end" onClick={() => onRetry(msg.retryText, msg.retryAttachment)}>
              Retry
            </button>
          ) : (
            <button className="ghost end" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
