import { describe, expect, it } from "vitest";
import type { Event, Task } from "@prisma/client";
import { normalizeGoogleEvent } from "@/server/calendar/normalize";
import { buildSnapshot, renderSms } from "@/server/briefings/generate";
import { dateOnlyToISO, isoToDateOnly } from "@/server/time";

describe("normalizeGoogleEvent", () => {
  it("stores timed events as UTC instants", () => {
    const e = normalizeGoogleEvent({
      id: "abc123",
      summary: " Lecture ",
      start: { dateTime: "2026-10-26T09:30:00-04:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-26T10:45:00-04:00" },
    })!;
    expect(e.externalId).toBe("abc123");
    expect(e.title).toBe("Lecture");
    expect(e.startAt?.toISOString()).toBe("2026-10-26T13:30:00.000Z");
    expect(e.allDay).toBe(false);
  });

  it("stores all-day events as date-only values", () => {
    const e = normalizeGoogleEvent({ id: "d1", start: { date: "2026-10-27" }, end: { date: "2026-10-28" } })!;
    expect(e.allDay).toBe(true);
    expect(dateOnlyToISO(e.startDate!)).toBe("2026-10-27");
    expect(e.startAt).toBeNull();
    expect(e.title).toBe("(No title)");
  });

  it("keeps cancelled instances without times and skips working-location events", () => {
    expect(normalizeGoogleEvent({ id: "x_20261027", status: "cancelled" })?.status).toBe("cancelled");
    expect(normalizeGoogleEvent({ id: "w", eventType: "workingLocation", start: { date: "2026-10-27" } })).toBeNull();
  });
});

function event(p: Partial<Event>): Event {
  return {
    id: p.id ?? "e", userId: "u", provider: "google_calendar", calendarId: "primary", externalId: p.id ?? "e",
    title: "Event", description: null, location: null, allDay: false, startAt: null, endAt: null, startDate: null,
    endDate: null, sourceTimezone: null, status: "confirmed", htmlLink: null, verification: "confirmed",
    externalUpdatedAt: null, lastSyncedAt: new Date(), deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...p,
  };
}
function task(p: Partial<Task>): Task {
  return {
    id: p.id ?? "t", userId: "u", title: "Task", description: null, dueAt: null, dueDate: null, priority: "medium",
    status: "open", category: null, effortMinutes: null, sourceType: "manual", sourceRef: null, verification: "confirmed",
    completedAt: null, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...p,
  };
}

describe("briefing", () => {
  const zone = "America/New_York";
  const today = "2026-10-25";

  it("places events on the user's local day across the DST change", () => {
    const s = buildSnapshot(
      [
        // 23:30 local on Oct 25 is Oct 26 in UTC.
        event({ id: "late", title: "Late study group", startAt: new Date("2026-10-26T03:30:00Z") }),
        // After DST ends on Nov 1: 09:00 EST = 14:00Z.
        event({ id: "post-dst", title: "Lab", startAt: new Date("2026-11-02T14:00:00Z") }),
        event({ id: "allday", title: "Midterm week", allDay: true, startDate: isoToDateOnly("2026-10-26"), endDate: isoToDateOnly("2026-10-28") }),
      ],
      [
        task({ id: "fri", title: "Finish reading", dueDate: isoToDateOnly("2026-10-30") }),
        task({ id: "old", title: "Essay draft", dueDate: isoToDateOnly("2026-10-23") }),
        task({ id: "nodate", title: "Email advisor" }),
      ],
      zone,
      today,
    );
    expect(s.days[0].events.map((e) => [e.title, e.time])).toEqual([["Late study group", "11:30pm"]]);
    expect(s.days.find((d) => d.date === "2026-10-30")?.tasksDue.map((t) => t.title)).toEqual(["Finish reading"]);
    expect(s.days.filter((d) => d.events.some((e) => e.id === "allday")).map((d) => d.date)).toEqual(["2026-10-26", "2026-10-27"]);
    expect(s.overdue.map((t) => t.title)).toEqual(["Essay draft"]);
    expect(s.undated.map((t) => t.title)).toEqual(["Email advisor"]);

    const sms = renderSms(s);
    expect(sms).toContain("Sun Oct 25 briefing");
    expect(sms).toContain("TODAY: 11:30pm Late study group");
    expect(sms).toContain("OVERDUE: Essay draft");
    expect(sms).toContain("Fri 1 due");
    expect(sms.length).toBeLessThan(400);

    // Nov 2 is outside the 7-day window starting Oct 25.
    expect(s.days.flatMap((d) => d.events).some((e) => e.id === "post-dst")).toBe(false);
    const later = buildSnapshot([event({ id: "post-dst", title: "Lab", startAt: new Date("2026-11-02T14:00:00Z") })], [], zone, "2026-11-01");
    expect(later.days[1].events[0]).toMatchObject({ date: "2026-11-02", time: "9:00am" });
  });
});
