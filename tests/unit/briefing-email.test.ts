import { describe, expect, it } from "vitest";
import type { Event, Task } from "@prisma/client";
import { computeFreeSlots, formatSlot } from "@/server/scheduling/availability";
import { buildSnapshot } from "@/server/briefings/generate";
import { renderEmailHtml, renderEmailText } from "@/server/briefings/render-email";
import { buildMime, payloadText } from "@/server/email/mime";
import { isoToDateOnly } from "@/server/time";

const zone = "America/New_York";

function event(p: Partial<Event>): Event {
  return {
    id: p.id ?? "e", userId: "u", provider: "google_calendar", calendarId: "primary", externalId: p.id ?? "e",
    title: "Event", description: null, location: null, allDay: false, startAt: null, endAt: null, startDate: null,
    endDate: null, sourceTimezone: null, status: "confirmed", htmlLink: null, verification: "confirmed",
    externalUpdatedAt: null, lastSyncedAt: new Date(), deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...p,
  } as Event;
}
function task(p: Partial<Task>): Task {
  return {
    id: p.id ?? "t", userId: "u", title: "Task", description: null, dueAt: null, dueDate: null, priority: "medium",
    status: "open", category: null, effortMinutes: null, sourceType: "manual", sourceRef: null, verification: "confirmed",
    completedAt: null, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...p,
  } as Task;
}
// 2026-11-10 is EST (UTC-5).
const at = (hhmm: string, date = "2026-11-10") => new Date(`${date}T${hhmm}:00-05:00`);

describe("computeFreeSlots", () => {
  it("returns gaps between overlapping timed events, ignoring all-day and cancelled ones", () => {
    const slots = computeFreeSlots(
      [
        event({ id: "a", startAt: at("09:00"), endAt: at("10:15") }),
        event({ id: "b", startAt: at("10:00"), endAt: at("11:00") }), // overlaps a
        event({ id: "c", startAt: at("11:10"), endAt: at("12:00") }), // 10-minute gap: too short
        event({ id: "d", startAt: at("13:00"), endAt: at("14:00"), status: "cancelled" }),
        event({ id: "allday", allDay: true, startDate: isoToDateOnly("2026-11-10"), endDate: isoToDateOnly("2026-11-11") }),
        event({ id: "e", startAt: at("21:30"), endAt: at("23:00") }),
      ],
      "2026-11-10",
      zone,
    );
    expect(slots.map((s) => formatSlot(s, zone))).toEqual(["8–9am", "12–9:30pm"]);
    expect(slots.map((s) => s.minutes)).toEqual([60, 570]);
  });

  it("never offers time that has already passed", () => {
    const slots = computeFreeSlots([], "2026-11-10", zone, {}, at("14:07"));
    expect(slots.map((s) => formatSlot(s, zone))).toEqual(["2:15–10pm"]);
    expect(computeFreeSlots([], "2026-11-10", zone, {}, at("22:30"))).toEqual([]);
  });

  it("uses local wall-clock hours on the DST change day", () => {
    // 2026-11-01: clocks fall back at 2:00. 08:00 local is 13:00Z (EST).
    const slots = computeFreeSlots([], "2026-11-01", zone);
    expect(slots[0].start).toBe("2026-11-01T13:00:00.000Z");
    expect(slots[0].minutes).toBe(14 * 60);
  });
});

describe("briefing snapshot + email", () => {
  const today = "2026-11-10";
  const snapshot = () =>
    buildSnapshot(
      [
        event({ id: "lec", title: "ECE Lecture", startAt: at("09:00"), endAt: at("10:15") }),
        event({ id: "inj", title: "<script>alert(1)</script> & Lab", startAt: at("13:00"), endAt: at("16:00") }),
        event({ id: "thu", title: "Club meeting", startAt: at("18:00", "2026-11-12"), endAt: at("19:00", "2026-11-12") }),
      ],
      [
        task({ id: "late", title: "Essay draft", dueDate: isoToDateOnly("2026-11-08") }),
        task({ id: "fri", title: "Problem set 6", dueDate: isoToDateOnly("2026-11-13") }),
        task({ id: "thu-hi", title: "Lab report", dueDate: isoToDateOnly("2026-11-12"), priority: "high" }),
        task({ id: "thu-lo", title: "Reading", dueDate: isoToDateOnly("2026-11-12"), priority: "low" }),
        task({ id: "none", title: "Email advisor" }),
      ],
      zone,
      today,
      at("07:55"),
    );

  it("numbers tasks in display order and suggests focus from urgency and free time", () => {
    const s = snapshot();
    expect(s.overdue[0].n).toBe(1);
    expect(s.days.flatMap((d) => d.tasksDue).map((t) => [t.n, t.title])).toEqual([
      [2, "Lab report"], [3, "Reading"], [4, "Problem set 6"],
    ]);
    expect(s.undated[0].n).toBe(5);
    expect(s.freeSlots!.map((x) => formatSlot(x, zone))).toEqual(["8–9am", "10:15am–1pm", "4–10pm"]);
    // Overdue first, then the high-priority Thursday task; the biggest block goes to the most urgent.
    expect(s.focus!.map((f) => [f.title, f.slot && formatSlot(f.slot, zone)])).toEqual([
      ["Reading", "8–9am"],
      ["Lab report", "10:15am–1pm"],
      ["Essay draft", "4–10pm"],
    ]);
  });

  it("renders text and HTML sections and escapes untrusted titles", () => {
    const s = snapshot();
    const text = renderEmailText(s);
    expect(text).toContain("Tuesday, November 10 — your briefing");
    expect(text).toContain("- 9:00am  ECE Lecture");
    expect(text).toContain("- 1. Essay draft — Sun Nov 8  [overdue]");
    expect(text).toContain("SUGGESTED FOCUS");
    expect(text).toContain("Thursday Nov 12");
    expect(text).toContain("  due: 2. Lab report (!)");
    expect(text).toContain("Add task: finish reading Friday");

    const html = renderEmailHtml(s);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; Lab");
    expect(html).toContain("Suggestions only");
  });
});

describe("multipart MIME", () => {
  it("sends text and HTML alternatives; replies still read the text part", () => {
    const mime = buildMime({ from: "me@x.test", to: "me@x.test", subject: "Your briefing", body: "TODAY\nhi", html: "<p>hi</p>", kind: "briefing" });
    const [head] = mime.split("\r\n\r\n");
    expect(head).toContain("X-PA-Generated: briefing");
    const boundary = /boundary="([^"]+)"/.exec(head)![1];
    const parts = mime.split(`--${boundary}`).slice(1, 3);
    const decode = (p: string) => Buffer.from(p.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(parts[0]).toContain("Content-Type: text/plain");
    expect(decode(parts[0])).toBe("TODAY\r\nhi");
    expect(parts[1]).toContain("Content-Type: text/html");
    expect(decode(parts[1])).toBe("<p>hi</p>");
    expect(mime.trimEnd().endsWith(`--${boundary}--`)).toBe(true);

    const gmailPayload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("Add task: x").toString("base64url") } },
        { mimeType: "text/html", body: { data: Buffer.from("<b>ignored</b>").toString("base64url") } },
      ],
    };
    expect(payloadText(gmailPayload)).toBe("Add task: x");
  });
});
