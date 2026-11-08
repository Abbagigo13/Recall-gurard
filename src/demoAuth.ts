// Minimal demo-access client (Phase 6B).
//
// The session lives in an HttpOnly cookie the browser sends automatically;
// the CSRF token lives only in this module's memory (never localStorage).
// Mutations go through demoFetch, which attaches the CSRF header and
// refreshes it once when the server reports a mismatch.
let csrfToken: string | null = null;

export const AUTH_REQUIRED = 'AUTH_REQUIRED';
export const CSRF_INVALID = 'CSRF_INVALID';

async function ensureCsrf(): Promise<string | null> {
  if (csrfToken) return csrfToken;
  try {
    const res = await fetch('/api/recallguard/auth/csrf', { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
    return csrfToken;
  } catch {
    return null;
  }
}

export function forgetCsrf() {
  csrfToken = null;
}

export async function getAuthStatus(): Promise<boolean> {
  try {
    const res = await fetch('/api/recallguard/auth/status', { credentials: 'include' });
    if (!res.ok) return false;
    const data = await res.json();
    return data && data.authenticated === true;
  } catch {
    return false;
  }
}

export async function loginDemo(passphrase: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/recallguard/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.authenticated !== true) {
      return { ok: false, error: (data && data.error) || 'Login failed.' };
    }
    if (typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Network error during login.' };
  }
}

export async function logoutDemo(): Promise<void> {
  forgetCsrf();
  try {
    await fetch('/api/recallguard/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {
    // Logout is best-effort client-side; the session expiry bounds it.
  }
}

// Fetch wrapper for spend-bearing mutations: cookie session plus CSRF.
export async function demoFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  const token = await ensureCsrf();
  if (token) headers['x-csrf-token'] = token;
  let res = await fetch(input, { ...init, headers, credentials: 'include' });
  if (res.status === 403) {
    const data = await res.clone().json().catch(() => null);
    if (data && data.code === CSRF_INVALID) {
      csrfToken = null;
      const retry = await ensureCsrf();
      if (retry) {
        headers['x-csrf-token'] = retry;
        res = await fetch(input, { ...init, headers, credentials: 'include' });
      }
    }
  }
  return res;
}
