import { useState } from "react";
import { setToken } from "./auth.js";

export default function Login({ api, onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${api}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (res.status === 401) throw new Error("Wrong username or password.");
      if (res.status === 429) throw new Error("Too many failed attempts. Wait a few minutes and try again.");
      if (!res.ok) throw new Error("Something went wrong. Please try again.");
      const d = await res.json();
      setToken(d.token);
      onLogin();
    } catch (err) {
      setError(
        err instanceof TypeError
          ? "Can't reach the server. If it was asleep, give it a few seconds and try again."
          : err.message
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>Lizzie AI</h1>
        <p className="login-sub">Private assistant. Sign in to continue.</p>
        <label>
          Username
          <input
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <button className="login-btn" type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
