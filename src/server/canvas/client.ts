import { z } from "zod";

/**
 * Minimal Canvas LMS REST client (personal access token). Responses are validated with Zod;
 * names and links from Canvas are untrusted text and are only ever stored and displayed.
 */

export class CanvasApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const courseSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  course_code: z.string().optional(),
  access_restricted_by_date: z.boolean().optional(),
});
export type CanvasCourse = z.infer<typeof courseSchema>;

const assignmentSchema = z.object({
  id: z.number(),
  name: z.string(),
  due_at: z.string().nullable().optional(),
  html_url: z.string().optional(),
  published: z.boolean().optional(),
  submission: z
    .object({
      submitted_at: z.string().nullable().optional(),
      workflow_state: z.string().optional(), // unsubmitted | submitted | graded | pending_review
      excused: z.boolean().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type CanvasAssignment = z.infer<typeof assignmentSchema>;

const selfSchema = z.object({ id: z.number(), name: z.string().optional() });

const MAX_RETRIES = 2;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** rel="next" URL from a Canvas Link header, if any. */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

async function canvasGet(url: string, token: string, fetchImpl: typeof fetch): Promise<{ body: unknown; next: string | null }> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new CanvasApiError(`Network error calling Canvas: ${(err as Error).message}`, 0);
    }
    if (res.ok) return { body: await res.json(), next: nextLink(res.headers.get("link")) };
    // Canvas throttles with 403 + "Rate Limit Exceeded"; treat it like 429.
    const text = await res.text().catch(() => "");
    const throttled = res.status === 429 || (res.status === 403 && /rate limit/i.test(text));
    if ((throttled || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(800 * 2 ** attempt);
      continue;
    }
    let message = res.statusText;
    try {
      const j = JSON.parse(text) as { errors?: { message?: string }[]; message?: string };
      message = j.errors?.[0]?.message ?? j.message ?? message;
    } catch {
      /* not JSON */
    }
    throw new CanvasApiError(`Canvas API ${res.status}: ${message}`, res.status);
  }
}

async function getAll<T>(url: string, token: string, schema: z.ZodType<T>, fetchImpl: typeof fetch, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  for (let page = 0; next && page < maxPages; page++) {
    const res = await canvasGet(next, token, fetchImpl);
    out.push(...z.array(schema).parse(res.body));
    next = res.next;
  }
  return out;
}

export type CanvasClient = ReturnType<typeof canvasClient>;

export function canvasClient(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch }) {
  const base = opts.baseUrl.replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  return {
    async self() {
      return selfSchema.parse((await canvasGet(`${base}/api/v1/users/self`, opts.token, f)).body);
    },
    async activeCourses() {
      const courses = await getAll(`${base}/api/v1/courses?enrollment_state=active&per_page=100`, opts.token, courseSchema, f);
      return courses.filter((c) => !c.access_restricted_by_date && c.name);
    },
    async assignments(courseId: number) {
      return getAll(
        `${base}/api/v1/courses/${courseId}/assignments?include[]=submission&per_page=100&order_by=due_at`,
        opts.token,
        assignmentSchema,
        f,
      );
    },
  };
}
