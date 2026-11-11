import { jsonResponse } from "./helpers";

export const CANVAS_TEST_URL = "https://canvas.example.test";
export const CANVAS_TOKEN = "1234~validcanvastokenvalidcanvastoken";

type Assignment = {
  id: number;
  name: string;
  due_at: string | null;
  html_url?: string;
  published?: boolean;
  submission?: { submitted_at?: string | null; workflow_state?: string } | null;
};

/** In-memory Canvas: users/self, active courses and paginated assignments (2 per page). */
export function fakeCanvas() {
  const courses = new Map<number, { name: string; assignments: Assignment[] }>();
  const state = { failNext: 0 as number, failStatus: 503, requests: 0 };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    state.requests++;
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${CANVAS_TOKEN}`) return jsonResponse({ errors: [{ message: "Invalid access token." }] }, 401);
    if (state.failNext > 0) {
      state.failNext--;
      return jsonResponse({ errors: [{ message: "Service unavailable" }] }, state.failStatus);
    }
    const u = new URL(url);
    if (u.pathname === "/api/v1/users/self") return jsonResponse({ id: 1, name: "Student" });
    if (u.pathname === "/api/v1/courses") {
      return jsonResponse([...courses].map(([id, c]) => ({ id, name: c.name, course_code: `C${id}` })));
    }
    const m = /^\/api\/v1\/courses\/(\d+)\/assignments$/.exec(u.pathname);
    if (m) {
      const list = courses.get(Number(m[1]))?.assignments ?? [];
      const page = Number(u.searchParams.get("page") ?? "1");
      const slice = list.slice((page - 1) * 2, page * 2);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (page * 2 < list.length) {
        const next = new URL(url);
        next.searchParams.set("page", String(page + 1));
        headers.link = `<${next.toString()}>; rel="next", <${url}>; rel="first"`;
      }
      return new Response(JSON.stringify(slice), { status: 200, headers });
    }
    throw new Error(`unexpected Canvas request ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, courses, state };
}
