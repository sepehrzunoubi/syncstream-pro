/** A JSON POST to one of the app's routes that never throws: offline is reported like any other failure */
export async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    // Offline or the request never reached the server: report it, never throw into a debounce
    return { ok: false, status: 0, data: { error: "You're offline, or Google can't be reached" } as T & { error?: string } };
  }
  let data = {} as T & { error?: string };
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}
