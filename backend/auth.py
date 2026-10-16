"""Single-user login: scrypt-hashed password in the database + expiring bearer-token sessions.

- The browser keeps the token in sessionStorage, so closing the browser (or shutting the
  computer down) logs you out. The server also expires sessions after SESSION_IDLE_MINUTES
  of inactivity and SESSION_MAX_HOURS in total, and /auth/logout deletes the session.
- Only a SHA-256 hash of each token is stored, so a leaked database can't be replayed.
- There is no sign-up. The account comes from ADMIN_USERNAME / ADMIN_PASSWORD (applied at
  startup) or from `python create_user.py`.
"""
import hashlib
import hmac
import logging
import os
import secrets
import time
from collections import defaultdict, deque
from datetime import timedelta
from typing import Optional

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from db import AuthSession, SessionLocal, User, get_db, now

log = logging.getLogger("lizzie.auth")

IDLE = timedelta(minutes=int(os.environ.get("SESSION_IDLE_MINUTES") or 30))
MAX_AGE = timedelta(hours=int(os.environ.get("SESSION_MAX_HOURS") or 12))
MIN_PASSWORD_LEN = 10
MAX_FAILS = 5          # failed logins allowed per IP ...
FAIL_WINDOW = 15 * 60  # ... within this many seconds

bearer = HTTPBearer(auto_error=False)
_fails: dict = defaultdict(deque)


# ---------- passwords ---------------------------------------------------------
def hash_password(password: str) -> str:
    salt = os.urandom(16)
    n, r, p = 2**14, 8, 1
    dk = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=32)
    return f"scrypt${n}${r}${p}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, dk = stored.split("$")
        calc = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=len(dk) // 2
        )
        return hmac.compare_digest(calc, bytes.fromhex(dk))
    except Exception:
        return False


_DUMMY_HASH = hash_password("not-a-real-password")  # keeps timing equal for unknown usernames


def _norm(username: str) -> str:
    return (username or "").strip().lower()


def set_user(db: Session, username: str, password: str) -> None:
    """Create the user, or change their password (which also logs out every session)."""
    username = _norm(username)
    if not username or len(password) < MIN_PASSWORD_LEN:
        raise ValueError(f"Username is required and the password must be at least {MIN_PASSWORD_LEN} characters.")
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        db.add(User(username=username, password_hash=hash_password(password)))
    elif not verify_password(password, user.password_hash):
        user.password_hash = hash_password(password)
        db.query(AuthSession).filter(AuthSession.user_id == user.id).delete()
    db.commit()


def ensure_admin() -> None:
    """Apply ADMIN_USERNAME / ADMIN_PASSWORD at startup (handy on hosts without a shell)."""
    username, password = _norm(os.environ.get("ADMIN_USERNAME", "")), os.environ.get("ADMIN_PASSWORD", "")
    with SessionLocal() as db:
        if username and password:
            try:
                set_user(db, username, password)
            except ValueError as e:
                log.error("ADMIN_* ignored: %s", e)
        if db.query(User).count() == 0:
            log.warning("No user exists, so nobody can log in. Set ADMIN_USERNAME and ADMIN_PASSWORD.")


# ---------- sessions ------------------------------------------------------------
def client_ip(request: Request) -> str:
    # The rightmost X-Forwarded-For entry is the one added by the host's own proxy;
    # anything to its left was supplied by the client and can be faked.
    forwarded = request.headers.get("x-forwarded-for", "")
    parts = [p.strip() for p in forwarded.split(",") if p.strip()]
    return parts[-1] if parts else (request.client.host if request.client else "unknown")


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _aware(dt):
    # SQLite hands datetimes back without tzinfo; everything we store is UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=now().tzinfo)


def login(db: Session, username: str, password: str, ip: str) -> dict:
    t = time.monotonic()
    q = _fails[ip]
    while q and t - q[0] > FAIL_WINDOW:
        q.popleft()
    if len(q) >= MAX_FAILS:
        raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")

    user = db.query(User).filter(User.username == _norm(username)).first()
    ok = verify_password(password, user.password_hash if user else _DUMMY_HASH)
    if not (user and ok):
        q.append(t)
        if len(_fails) > 2000:
            for k in [k for k, v in _fails.items() if not v]:
                del _fails[k]
        raise HTTPException(401, "Invalid username or password")
    _fails.pop(ip, None)

    stamp = now()
    db.query(AuthSession).filter(AuthSession.expires_at < stamp).delete()  # tidy up old rows
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(token_hash=_hash_token(token), user_id=user.id,
                       created_at=stamp, last_seen_at=stamp, expires_at=stamp + MAX_AGE))
    db.commit()
    return {"token": token, "username": user.username}


def revoke(db: Session, token: str) -> None:
    db.query(AuthSession).filter(AuthSession.token_hash == _hash_token(token)).delete()
    db.commit()


def current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer), db: Session = Depends(get_db)
) -> User:
    unauthorized = HTTPException(401, "Not logged in", headers={"WWW-Authenticate": "Bearer"})
    if not creds:
        raise unauthorized
    sess = db.get(AuthSession, _hash_token(creds.credentials))
    if not sess:
        raise unauthorized
    t = now()
    if _aware(sess.expires_at) <= t or t - _aware(sess.last_seen_at) > IDLE:
        db.delete(sess)
        db.commit()
        raise unauthorized
    if t - _aware(sess.last_seen_at) > timedelta(seconds=60):  # sliding idle timeout
        sess.last_seen_at = t
        db.commit()
    user = db.get(User, sess.user_id)
    if not user:
        raise unauthorized
    return user
