"""Accounts: scrypt password hashes, hashed session tokens, login rate limiting."""

import hashlib
import hmac
import secrets
import time

from fastapi import Depends, HTTPException, Request

from .db import Database

SESSION_DAYS = 30
COOKIE = "mediawan"


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"{salt.hex()}:{key.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, key_hex = stored.split(":")
        salt, expected = bytes.fromhex(salt_hex), bytes.fromhex(key_hex)
    except ValueError:
        return False
    key = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(key, expected)


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Accounts:
    def __init__(self, db: Database):
        self.db = db
        self.attempts: dict[str, tuple[float, int]] = {}

    def bootstrap_admin(self, email: str, password: str):
        if self.db.one("SELECT id FROM users LIMIT 1") or not email or len(password) < 10:
            return
        self.create(email, "Administrator", password, role="admin")

    def create(self, email: str, name: str, password: str, role: str = "member") -> int:
        if "@" not in email or len(password) < 10 or not name.strip():
            raise HTTPException(400, "Use a valid email, a name and a password of 10+ characters")
        if self.db.one("SELECT id FROM users WHERE email=?", email.lower()):
            raise HTTPException(409, "That email already has an account")
        return self.db.run(
            "INSERT INTO users(email,name,pw_hash,role) VALUES(?,?,?,?)",
            email.lower(),
            name.strip(),
            hash_password(password),
            role,
        )

    def login(self, email: str, password: str, client: str) -> tuple[dict, str]:
        now = time.time()
        start, count = self.attempts.get(client, (now, 0))
        if now - start > 900:
            start, count = now, 0
        if count >= 15:
            raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")
        self.attempts[client] = (start, count + 1)
        user = self.db.one("SELECT * FROM users WHERE email=? AND active=1", email.lower())
        if not user or not verify_password(password, user["pw_hash"]):
            raise HTTPException(401, "Email or password is incorrect")
        self.attempts.pop(client, None)
        token = secrets.token_hex(32)
        self.db.run("DELETE FROM sessions WHERE expires<?", int(now))
        self.db.run(
            "INSERT INTO sessions VALUES(?,?,?)",
            _digest(token),
            user["id"],
            int(now + SESSION_DAYS * 86400),
        )
        return user, token

    def logout(self, token: str):
        self.db.run("DELETE FROM sessions WHERE token_hash=?", _digest(token))

    def user_for(self, token: str | None) -> dict | None:
        if not token:
            return None
        return self.db.one(
            "SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id "
            "WHERE token_hash=? AND expires>? AND active=1",
            _digest(token),
            int(time.time()),
        )


def public(user: dict) -> dict:
    return {k: user[k] for k in ("id", "email", "name", "role")}


def current_user(request: Request) -> dict:
    user = request.app.state.accounts.user_for(request.cookies.get(COOKIE))
    if not user:
        raise HTTPException(401, "Sign in to continue")
    return user


def admin_user(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "Administrator access required")
    return user
