import { jsonResponse } from "./helpers";

type FakeMessage = { id: string; threadId: string; labelIds: string[]; internalDate: string; headers: Record<string, string>; text: string };

/** In-memory Gmail: messages.send and threads.get, enough to exercise the real code paths. */
export function fakeGmail() {
  const messages: FakeMessage[] = [];
  const sends: { headers: Record<string, string>; text: string; threadId?: string }[] = [];
  let n = 0;
  const add = (m: Omit<FakeMessage, "id">) => {
    const id = `m${++n}`;
    messages.push({ id, ...m });
    return id;
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer valid-access-token") return jsonResponse({ error: { message: "Invalid Credentials" } }, 401);
    if (url.endsWith("/messages/send")) {
      const { raw, threadId } = JSON.parse(String(init!.body)) as { raw: string; threadId?: string };
      const [head, body] = Buffer.from(raw, "base64url").toString("utf8").split("\r\n\r\n");
      const headers = Object.fromEntries(head.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
      const text = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
      sends.push({ headers, text, threadId });
      const tid = threadId ?? `t${n + 1}`;
      // Mail to yourself lands in your own inbox, which is what "delivered" checks for.
      const id = add({ threadId: tid, labelIds: ["SENT", "INBOX"], internalDate: String(Date.now()), headers: { ...headers, "Message-ID": `<gen${n}@x>` }, text });
      return jsonResponse({ id, threadId: tid, labelIds: ["SENT"] });
    }
    const thread = /\/threads\/([^?]+)/.exec(url)?.[1];
    if (thread) {
      const msgs = messages.filter((m) => m.threadId === thread);
      if (!msgs.length) return jsonResponse({ error: { message: "Not Found" } }, 404);
      return jsonResponse({
        id: thread,
        messages: msgs.map((m) => ({
          id: m.id,
          threadId: m.threadId,
          labelIds: m.labelIds,
          internalDate: m.internalDate,
          payload: {
            mimeType: "text/plain",
            headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })),
            body: { data: Buffer.from(m.text, "utf8").toString("base64url") },
          },
        })),
      });
    }
    throw new Error(`unexpected request ${url}`);
  }) as unknown as typeof fetch;
  const reply = (threadId: string, from: string, text: string, at = new Date()) =>
    add({ threadId, labelIds: ["INBOX"], internalDate: String(at.getTime()), headers: { From: from, Subject: "Re: Your briefing", "Message-ID": `<r${n}@mail.gmail.com>` }, text });
  return { fetchImpl, sends, reply };
}
