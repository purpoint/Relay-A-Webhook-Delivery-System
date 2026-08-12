/**
 * The API client, and the place the token-storage decision actually lives.
 *
 * The access token is held in this module variable and nowhere else. Not
 * localStorage, not sessionStorage, not a readable cookie — all of which any
 * injected script can read, so a single XSS bug would hand over a working
 * credential.
 *
 * Keeping it in memory means it dies with the tab. That would be a miserable
 * experience on its own, which is why the refresh token exists: it lives in an
 * httpOnly cookie the browser sends automatically and JavaScript cannot read,
 * so a page reload silently recovers the session without the token ever having
 * been readable.
 */

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
}

export interface ApiError extends Error {
  status: number;
  code: string;
}

function apiError(status: number, code: string, message: string): ApiError {
  const error = new Error(message) as ApiError;
  error.status = status;
  error.code = code;
  return error;
}

interface Envelope<T> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Internal: prevents a refresh loop. See below. */
  retrying?: boolean;
}

async function rawRequest<T>(path: string, options: RequestOptions = {}): Promise<Response> {
  return fetch(path, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    // Required for the refresh cookie to be sent at all. Same-origin here, so
    // this is the browser default, but stating it makes the dependency
    // explicit rather than accidental.
    credentials: "same-origin",
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
}

/**
 * Call the API, transparently refreshing an expired access token.
 *
 * Access tokens last fifteen minutes and the page stays open far longer, so
 * expiry during normal use is the common case, not an edge case. Rather than
 * tracking the clock, we let the request fail once with 401 and recover.
 *
 * `retrying` is what stops that recovery becoming a loop: if the retry also
 * fails, the refresh token is genuinely gone and the user must sign in again.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await rawRequest<T>(path, options);

  if (response.status === 401 && !options.retrying && path !== "/api/v1/auth/refresh") {
    const refreshed = await tryRefresh();

    if (refreshed) {
      response = await rawRequest<T>(path, { ...options, retrying: true });
    }
  }

  const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;

  if (!response.ok) {
    throw apiError(
      response.status,
      envelope?.error?.code ?? "UNKNOWN",
      envelope?.error?.message ?? `Request failed with ${String(response.status)}`,
    );
  }

  return envelope?.data as T;
}

/**
 * Exchange the refresh cookie for a new access token.
 *
 * Returns false rather than throwing when there is no valid session — the
 * caller treats that as "not signed in", which is an ordinary state on first
 * load, not an error.
 */
export async function tryRefresh(): Promise<boolean> {
  const response = await fetch("/api/v1/auth/refresh", {
    method: "POST",
    credentials: "same-origin",
  });

  if (!response.ok) {
    accessToken = null;
    return false;
  }

  const envelope = (await response.json()) as Envelope<{ token: string }>;
  accessToken = envelope.data?.token ?? null;

  return accessToken !== null;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export interface MonitorSnapshot {
  window: {
    ready: number;
    inFlight: number;
    occupancy: number;
    capacity: number;
    utilisation: number;
  };
  deliveries: Record<string, number>;
  totals: { events: number; deliveries: number };
  at: string;
}

export async function login(email: string, password: string): Promise<User> {
  const data = await api<{ user: User; token: string }>("/api/v1/auth/login", {
    method: "POST",
    body: { email, password },
  });

  setAccessToken(data.token);
  return data.user;
}

export async function register(email: string, password: string): Promise<User> {
  const data = await api<{ user: User; token: string }>("/api/v1/auth/register", {
    method: "POST",
    body: { email, password },
  });

  setAccessToken(data.token);
  return data.user;
}

export async function logout(): Promise<void> {
  await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" });
  setAccessToken(null);
}

export async function me(): Promise<User> {
  return api<User>("/api/v1/auth/me");
}

export async function listProjects(): Promise<Project[]> {
  return api<Project[]>("/api/v1/projects");
}

export async function createProject(name: string): Promise<Project> {
  return api<Project>("/api/v1/projects", { method: "POST", body: { name } });
}

export async function monitor(projectId: string): Promise<MonitorSnapshot> {
  return api<MonitorSnapshot>(`/api/v1/projects/${projectId}/monitor`);
}
