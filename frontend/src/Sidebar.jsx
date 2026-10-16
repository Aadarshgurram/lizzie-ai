export default function Sidebar({ open, onClose, onCollapse, conversations, activeId, onSelect, onDelete, onNew }) {
  return (
    <>
{open && (
  <button
    type="button"
    className="scrim only-mobile"
    onClick={onClose}
    aria-label="Close chat sidebar"
  />
)}
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="sidebar-inner">
          <div className="side-head">
            <div className="side-head-left">
              <button className="ghost icon-btn" onClick={onCollapse} aria-label="Collapse sidebar">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2.5" />
                  <line x1="9.5" y1="4" x2="9.5" y2="20" />
                </svg>
              </button>
              <span>Chats</span>
            </div>
            <button className="ghost icon-btn" onClick={onNew} aria-label="New chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>
          <nav className="side-list">
            {conversations.length === 0 && <p className="side-empty">No conversations yet</p>}
            {conversations.map((c) => (
              <div key={c.id} className={`side-item${c.id === activeId ? " active" : ""}`}>
                <button className="side-title" onClick={() => onSelect(c.id)} title={c.title}>
                  {c.title || "New chat"}
                </button>
                <button
                  className="side-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("Delete this conversation?")) onDelete(c.id);
                  }}
                  aria-label="Delete conversation"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" /></svg>
                </button>
              </div>
            ))}
          </nav>
        </div>
      </aside>
    </>
  );
}
