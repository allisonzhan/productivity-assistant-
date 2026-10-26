import { z } from "zod";

export class GoogleApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const dateOrDateTime = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});

export const googleEventSchema = z.object({
  id: z.string(),
  status: z.string().optional(), // confirmed | tentative | cancelled
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  htmlLink: z.string().optional(),
  updated: z.string().optional(),
  eventType: z.string().optional(),
  start: dateOrDateTime.optional(),
  end: dateOrDateTime.optional(),
});
export type GoogleEvent = z.infer<typeof googleEventSchema>;

const listResponse = z.object({
  items: z.array(googleEventSchema).default([]),
  nextPageToken: z.string().optional(),
});

const API = "https://www.googleapis.com/calendar/v3";
const MAX_RETRIES = 2;

async function googleGet(url: string, accessToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new GoogleApiError(`Network error calling Google Calendar: ${(err as Error).message}`, 0);
    }
    if (res.ok) return res.json();
    // Bounded retries only for transient failures; auth errors fail fast.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(400 * 2 ** attempt);
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new GoogleApiError(`Google Calendar API ${res.status}: ${body.error?.message ?? res.statusText}`, res.status);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function listEvents(opts: {
  accessToken: string;
  calendarId: string;
  timeMin: Date;
  timeMax: Date;
  fetchImpl?: typeof fetch;
}): Promise<GoogleEvent[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      singleEvents: "true", // expand recurring events into stable per-instance IDs
      showDeleted: "true",
      maxResults: "250",
      timeMin: opts.timeMin.toISOString(),
      timeMax: opts.timeMax.toISOString(),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const url = `${API}/calendars/${encodeURIComponent(opts.calendarId)}/events?${params}`;
    const page = listResponse.parse(await googleGet(url, opts.accessToken, fetchImpl));
    events.push(...page.items);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return events;
}

/** The primary calendar's IANA timezone (used as the user's default timezone at sign-up). */
export async function getCalendarTimezone(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const json = (await googleGet(`${API}/calendars/primary`, accessToken, fetchImpl)) as { timeZone?: string };
    return json.timeZone ?? null;
  } catch {
    return null;
  }
}
