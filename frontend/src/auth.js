// Session token lives in sessionStorage: it is wiped when the browser/tab is closed (so
// shutting the computer down logs you out) and is never shared between tabs or devices.
const KEY = "lizzie.token";

export const getToken = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
export const setToken = (t) => {
  try {
    sessionStorage.setItem(KEY, t);
  } catch {}
};
export const clearToken = () => {
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
};

// fetch() that attaches the token. A 401 means the session ended (idle timeout, expiry,
// logout elsewhere), so drop the token and tell the app to show the login screen.
export async function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event("auth-expired"));
  }
  return res;
}
