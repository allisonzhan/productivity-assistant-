import { describe, expect, it } from "vitest";
import { resolveDateText } from "@/server/dates/resolve";
import { extractReplyText } from "@/server/email/mime";
import { parseSmsCommand } from "@/server/sms/commands";

const NY = "America/New_York";
const TUE = new Date("2026-11-10T14:00:00Z"); // Tue Nov 10, 9am NY
const date = (t: string, now = TUE) => {
  const r = resolveDateText(t, NY, now);
  return r.ok ? r.date : `ERR ${r.message}`;
};

describe("resolveDateText (deterministic)", () => {
  it("resolves relative words and weekdays from the user's local day", () => {
    expect(date("today")).toBe("2026-11-10");
    expect(date("Tomorrow")).toBe("2026-11-11");
    expect(date("sunday")).toBe("2026-11-15");
    expect(date("on Tue")).toBe("2026-11-10"); // same weekday = today
    expect(date("this Friday")).toBe("2026-11-13");
    expect(date("in 3 days")).toBe("2026-11-13");
    expect(date("in 2 weeks")).toBe("2026-11-24");
    // 11pm Nov 10 in New York is already Nov 11 in UTC; "tomorrow" is still Nov 11 locally.
    expect(date("tomorrow", new Date("2026-11-11T04:00:00Z"))).toBe("2026-11-11");
  });

  it("resolves numeric and month-name dates, rolling past dates into next year", () => {
    expect(date("11/14")).toBe("2026-11-14");
    expect(date("1/5")).toBe("2027-01-05");
    expect(date("2026-12-01")).toBe("2026-12-01");
    expect(date("Nov 20")).toBe("2026-11-20");
    expect(date("December 3rd")).toBe("2026-12-03");
    expect(date("Fri Nov 20")).toBe("2026-11-20");
    expect(date("3 March 2027")).toBe("2027-03-03");
  });

  it("asks instead of guessing", () => {
    expect(date("next friday")).toContain("could mean two different days");
    expect(date("2/30")).toContain("not a valid date");
    expect(date("whenever")).toContain("couldn't read");
  });
});

describe("reply text + confirmation keywords", () => {
  it("keeps every line above the quote for the agent", () => {
    const body = "push my essay to Sunday\nand make it high priority\n\nOn Tue, Nov 10, 2026 at 9:00 AM Me <me@x.test> wrote:\n> briefing";
    expect(extractReplyText(body)).toBe("push my essay to Sunday\nand make it high priority");
    expect(extractReplyText("> only quoted")).toBe("");
  });

  it("YES confirms (no longer START); NO cancels", () => {
    expect(parseSmsCommand("YES", { zone: NY })).toEqual({ type: "confirm" });
    expect(parseSmsCommand("y", { zone: NY })).toEqual({ type: "confirm" });
    expect(parseSmsCommand("No.", { zone: NY })).toEqual({ type: "cancel" });
    expect(parseSmsCommand("START", { zone: NY })).toEqual({ type: "start" });
    expect(parseSmsCommand("cancel", { zone: NY })).toEqual({ type: "stop", keyword: "CANCEL" });
  });
});
