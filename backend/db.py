"""SQLite persistence for conversations and messages.

Set DATABASE_URL to override, e.g.:
  sqlite:///./chatbot.db
"""
import os
import uuid
from datetime import datetime, timezone

from dotenv import load_dotenv
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, String, Text, create_engine, inspect, text
from sqlalchemy.orm import Session, declarative_base, relationship, sessionmaker

load_dotenv()  # reads backend/.env if present, so DATABASE_URL etc. can live there

# `or` (not a get() default) so an empty DATABASE_URL set in a host dashboard still falls back.
DATABASE_URL = os.environ.get("DATABASE_URL") or "sqlite:///./chatbot.db"
# Render/Railway/Heroku-style hosts hand out `postgres://` or plain
# `postgresql://` URLs; SQLAlchemy 2.0 needs an explicit driver in the scheme.
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)

_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


def new_id() -> str:
    return uuid.uuid4().hex


def now() -> datetime:
    return datetime.now(timezone.utc)


class Item(Base):
    """A note or a to-do task created through the assistant."""

    __tablename__ = "items"

    id = Column(String(32), primary_key=True, default=new_id)
    owner = Column(String(64), nullable=False, index=True)
    kind = Column(String(8), nullable=False, default="note")  # "note" | "task"
    text = Column(Text, nullable=False)
    done = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), default=now)


class Reminder(Base):
    __tablename__ = "reminders"

    id = Column(String(32), primary_key=True, default=new_id)
    owner = Column(String(64), nullable=False, index=True)
    text = Column(Text, nullable=False)
    due_at = Column(DateTime(timezone=True), nullable=False, index=True)
    notified = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), default=now)


class AuthSession(Base):
    """One row per logged-in browser. Only a SHA-256 hash of the bearer token is stored."""

    __tablename__ = "auth_sessions"

    token_hash = Column(String(64), primary_key=True)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=now)
    last_seen_at = Column(DateTime(timezone=True), default=now)
    expires_at = Column(DateTime(timezone=True), nullable=False)


class User(Base):
    __tablename__ = "users"

    id = Column(String(32), primary_key=True, default=new_id)
    username = Column(String(64), unique=True, nullable=False, index=True)
    password_hash = Column(String(300), nullable=False)
    created_at = Column(DateTime(timezone=True), default=now)


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(String(32), primary_key=True, default=new_id)
    title = Column(String(200), nullable=False, default="New chat")
    owner = Column(String(64), nullable=True, index=True)  # id of the user who owns the chat
    created_at = Column(DateTime(timezone=True), default=now)
    updated_at = Column(DateTime(timezone=True), default=now, onupdate=now)

    messages = relationship(
        "Message", back_populates="conversation", cascade="all, delete-orphan", order_by="Message.created_at"
    )

    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class Message(Base):
    __tablename__ = "messages"

    id = Column(String(32), primary_key=True, default=new_id)
    conversation_id = Column(String(32), ForeignKey("conversations.id"), nullable=False, index=True)
    role = Column(String(16), nullable=False)  # "user" | "assistant"
    content = Column(Text, nullable=False)
    source = Column(String(16), nullable=True)  # "nlp" | "llm" | "vision" | "fallback"
    attachment_path = Column(String(500), nullable=True)
    attachment_type = Column(String(16), nullable=True)  # "image" | "file"
    created_at = Column(DateTime(timezone=True), default=now)

    conversation = relationship("Conversation", back_populates="messages")

    def to_dict(self):
        return {
            "id": self.id,
            "role": self.role,
            "content": self.content,
            "source": self.source,
            "attachment_path": self.attachment_path,
            "attachment_type": self.attachment_type,
            "created_at": self.created_at.isoformat(),
        }


def init_db():
    Base.metadata.create_all(engine)
    # create_all never alters existing tables, so add `owner` to databases created before it existed.
    cols = {c["name"] for c in inspect(engine).get_columns("conversations")}
    if "owner" not in cols:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE conversations ADD COLUMN owner VARCHAR(64)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversations_owner ON conversations (owner)"))


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
