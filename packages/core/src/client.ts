// Cliente HTTP mínimo del core: un caso y un token. Sin reintentos; un rechazo lanza con { status, body }.
export type CoreError = Error & { status: number; body: any };

export function coreClient(o: { baseUrl: string; caseId: string; token: string; fetch?: typeof globalThis.fetch }) {
  const f = o.fetch ?? globalThis.fetch;
  const root = `${o.baseUrl.replace(/\/+$/, "")}/core/cases/${encodeURIComponent(o.caseId)}`;
  async function call(path: string, body?: unknown): Promise<any> {
    const res = await f(root + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${o.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await res.json().catch(() => undefined);
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${parsed?.error ?? ""}: ${parsed?.message ?? ""}`.trim()), { status: res.status, body: parsed }) as CoreError;
    return parsed;
  }
  return {
    send: (event: unknown) => call("/events", event),
    readEvidence: (event: unknown) => call("/evidence", event),
    inbox: () => call("/inbox"),
    state: () => call("/state"),
  };
}
