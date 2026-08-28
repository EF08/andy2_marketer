import type { Transport, Heartbeat, PollResponse, Completion } from "./types";

/** The full system: an HTTP backend owning the approval queue, rate governor and dashboard. */
export function createRemoteTransport(baseUrl: string, ingestKey: string): Transport {
  async function api(pathname: string, body: unknown): Promise<any> {
    const res = await fetch(new URL(pathname, baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-marketer-key": ingestKey },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${pathname}`);
    return res.json();
  }

  return {
    describe: `remote ${baseUrl}`,
    poll: (hb: Heartbeat) => api("/api/marketer/agent/poll", hb) as Promise<PollResponse>,
    complete: async (actionId: string, c: Completion) => {
      await api(`/api/marketer/agent/actions/${actionId}/complete`, c);
    },
  };
}
