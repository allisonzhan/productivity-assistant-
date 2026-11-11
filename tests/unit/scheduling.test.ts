import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, dueBriefings, type SchedulePrefs } from "@/server/scheduling/due";

const NY = "America/New_York";
const prefs = (p: Partial<SchedulePrefs> = {}): SchedulePrefs => ({ ...DEFAULT_PREFS, ...p });

describe("dueBriefings", () => {
  it("is due from the local time until the catch-up window closes", () => {
    // 8:00 EDT = 12:00Z on Oct 27, 2026
    expect(dueBriefings(NY, prefs(), new Date("2026-10-27T11:59:00Z"))).toEqual([]);
    expect(dueBriefings(NY, prefs(), new Date("2026-10-27T12:00:00Z"))).toEqual([
      { kind: "morning", forDate: "2026-10-27", scheduledFor: new Date("2026-10-27T12:00:00Z") },
    ]);
    expect(dueBriefings(NY, prefs(), new Date("2026-10-27T15:59:00Z"))).toHaveLength(1);
    expect(dueBriefings(NY, prefs(), new Date("2026-10-27T16:00:00Z"))).toEqual([]);
  });

  it("respects enabled flags and the evening slot", () => {
    const at = new Date("2026-10-27T23:30:00Z"); // 7:30 PM EDT
    expect(dueBriefings(NY, prefs(), at)).toEqual([]);
    expect(dueBriefings(NY, prefs({ eveningEnabled: true }), at).map((d) => d.kind)).toEqual(["evening"]);
    expect(dueBriefings(NY, prefs({ morningEnabled: false }), new Date("2026-10-27T12:30:00Z"))).toEqual([]);
  });

  it("keeps the local time across DST changes", () => {
    // Nov 1, 2026: clocks fall back, so 8:00 local is 13:00Z (EST) instead of 12:00Z.
    expect(dueBriefings(NY, prefs(), new Date("2026-11-01T12:30:00Z"))).toEqual([]);
    expect(dueBriefings(NY, prefs(), new Date("2026-11-01T13:00:00Z"))[0].scheduledFor).toEqual(new Date("2026-11-01T13:00:00Z"));
    // Mar 8, 2026: 2:30 AM does not exist; it resolves forward to 3:30 EDT (07:30Z).
    expect(dueBriefings(NY, prefs({ morningTime: "02:30" }), new Date("2026-03-08T07:30:00Z"))[0].scheduledFor).toEqual(
      new Date("2026-03-08T07:30:00Z"),
    );
  });

  it("defers during quiet hours, including windows that wrap midnight", () => {
    const quiet = prefs({ morningTime: "06:30", quietHoursStart: "22:00", quietHoursEnd: "07:00" });
    expect(dueBriefings(NY, quiet, new Date("2026-10-27T10:45:00Z"))).toEqual([]); // 6:45 local, quiet
    expect(dueBriefings(NY, quiet, new Date("2026-10-27T11:00:00Z"))).toHaveLength(1); // 7:00, quiet over, still in window
    const sameDay = prefs({ quietHoursStart: "08:00", quietHoursEnd: "09:00" });
    expect(dueBriefings(NY, sameDay, new Date("2026-10-27T12:30:00Z"))).toEqual([]);
    expect(dueBriefings(NY, sameDay, new Date("2026-10-27T13:00:00Z"))).toHaveLength(1);
  });

  it("uses the user's own zone", () => {
    // 8:00 in Tokyo on Oct 28 is 23:00Z on Oct 27.
    expect(dueBriefings("Asia/Tokyo", prefs(), new Date("2026-10-27T23:00:00Z"))[0].forDate).toBe("2026-10-28");
  });
});
