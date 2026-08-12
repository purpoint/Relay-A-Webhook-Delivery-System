import { useState, type FormEvent } from "react";
import { login, register, type User } from "./api";

interface Props {
  onSignedIn: (user: User) => void;
}

export function Auth({ onSignedIn }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const user = mode === "login" ? await login(email, password) : await register(email, password);
      onSignedIn(user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card panel">
        <h1>Relay</h1>
        <p className="subtitle" style={{ marginBottom: 0 }}>
          {mode === "login" ? "Sign in to view the execution window." : "Create an account."}
        </p>

        <form onSubmit={(e) => void submit(e)}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {mode === "register" && (
            <p className="muted" style={{ marginTop: 8 }}>
              At least 12 characters. No symbol or capital required — length is what
              matters, and composition rules push people towards weaker passwords.
            </p>
          )}

          {error && <div className="error">{error}</div>}

          <button className="full" type="submit" disabled={busy}>
            {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <p className="switch">
          {mode === "login" ? "No account? " : "Already have one? "}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "Create one" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
