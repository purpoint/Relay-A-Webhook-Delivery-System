import { useEffect, useState } from "react";
import {
  createProject,
  listProjects,
  logout,
  me,
  tryRefresh,
  type Project,
  type User,
} from "./api";
import { Auth } from "./Auth";
import { Monitor } from "./Monitor";

type Phase = "restoring" | "signed-out" | "signed-in";

export function App() {
  const [phase, setPhase] = useState<Phase>("restoring");
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  /**
   * Restore the session on load.
   *
   * The access token lives only in memory, so a page refresh always starts
   * without one. The refresh cookie is httpOnly and sent automatically, so
   * this exchange silently recovers the session — the user never sees a login
   * screen they did not ask for, and the token was never readable by script.
   */
  useEffect(() => {
    void (async () => {
      const restored = await tryRefresh();

      if (!restored) {
        setPhase("signed-out");
        return;
      }

      try {
        setUser(await me());
        setPhase("signed-in");
      } catch {
        setPhase("signed-out");
      }
    })();
  }, []);

  // Load projects whenever a session begins.
  useEffect(() => {
    if (phase !== "signed-in") return;

    void (async () => {
      const found = await listProjects();
      setProjects(found);
      setSelected((current) => current ?? found[0]?.id ?? null);
    })();
  }, [phase]);

  if (phase === "restoring") {
    return <div className="auth-wrap"><p className="muted">Loading…</p></div>;
  }

  if (phase === "signed-out") {
    return (
      <Auth
        onSignedIn={(signedIn) => {
          setUser(signedIn);
          setPhase("signed-in");
        }}
      />
    );
  }

  const project = projects.find((p) => p.id === selected) ?? null;

  return (
    <div className="page">
      <header className="bar">
        <h1>Relay — Execution Window</h1>
        <span className="muted">
          {user?.email}{" "}
          <button
            className="secondary"
            onClick={() => {
              void logout().then(() => {
                setUser(null);
                setProjects([]);
                setSelected(null);
                setPhase("signed-out");
              });
            }}
          >
            Sign out
          </button>
        </span>
      </header>

      <p className="subtitle">
        Postgres stores every event permanently. Redis holds only the jobs that are
        executable right now, and never more than the cap — however large the backlog
        behind it grows.
      </p>

      {projects.length === 0 ? (
        <NoProjects
          onCreated={(created) => {
            setProjects([created]);
            setSelected(created.id);
          }}
        />
      ) : (
        <>
          {projects.length > 1 && (
            <div className="toolbar">
              <select
                value={selected ?? ""}
                onChange={(e) => setSelected(e.target.value)}
                aria-label="Project"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {project && <Monitor project={project} />}
        </>
      )}
    </div>
  );
}

function NoProjects({ onCreated }: { onCreated: (project: Project) => void }) {
  const [name, setName] = useState("My project");
  const [busy, setBusy] = useState(false);

  return (
    <div className="panel" style={{ maxWidth: 420 }}>
      <p className="muted" style={{ marginTop: 0 }}>
        You have no projects yet. Create one, then publish events to it to watch the
        window fill.
      </p>
      <label htmlFor="project-name">Project name</label>
      <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} />
      <button
        className="full"
        disabled={busy || name.trim() === ""}
        onClick={() => {
          setBusy(true);
          void createProject(name.trim())
            .then(onCreated)
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Creating…" : "Create project"}
      </button>
    </div>
  );
}
