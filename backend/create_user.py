"""Create the login, or reset its password:   py create_user.py

Uses DATABASE_URL from backend/.env (or the environment), so to set the password on your
deployed database run it with that database's URL, e.g. in PowerShell:
    $env:DATABASE_URL="postgresql://..."; py create_user.py
"""
import getpass

import auth
from db import SessionLocal, init_db

init_db()
username = input("Username: ").strip()
password = getpass.getpass(f"Password (min {auth.MIN_PASSWORD_LEN} characters): ")
if password != getpass.getpass("Repeat password: "):
    raise SystemExit("Passwords didn't match.")
with SessionLocal() as db:
    try:
        auth.set_user(db, username, password)
    except ValueError as e:
        raise SystemExit(str(e))
print("Done. You can now log in as", username.lower())
