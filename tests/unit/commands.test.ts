import { describe, expect, it } from "vitest";
import { parseSmsCommand } from "@/server/sms/commands";

const NY = "America/New_York";
// Sunday 2026-10-25, 10:00 in New York.
const SUNDAY = new Date("2026-10-25T14:00:00Z");

describe("parseSmsCommand", () => {
  it("parses the acceptance message with a weekday due date in the user's timezone", () => {
    expect(parseSmsCommand("Add task: finish reading Friday", { zone: NY, now: SUNDAY })).toEqual({
      type: "add",
      title: "Finish reading",
      dueDate: "2026-10-30",
      dateText: "Friday",
    });
  });

  it("treats the same weekday as today", () => {
    const friday = new Date("2026-10-30T16:00:00Z");
    expect(parseSmsCommand("add task: essay fri", { zone: NY, now: friday })).toMatchObject({ dueDate: "2026-10-30" });
  });

  it("resolves relative days against the local date, not UTC", () => {
    // 22:30 Friday in New York is already Saturday in UTC.
    const lateFriday = new Date("2026-10-31T02:30:00Z");
    expect(parseSmsCommand("Add call mom tomorrow", { zone: NY, now: lateFriday })).toMatchObject({
      title: "Call mom",
      dueDate: "2026-10-31",
    });
    expect(parseSmsCommand("Add call mom tomorrow", { zone: "UTC", now: lateFriday })).toMatchObject({ dueDate: "2026-11-01" });
  });

  it("supports connectors and numeric dates, rolling past dates to next year", () => {
    expect(parseSmsCommand("todo read ch 3 by mon", { zone: NY, now: SUNDAY })).toMatchObject({ title: "Read ch 3", dueDate: "2026-10-26" });
    expect(parseSmsCommand("Add task: lab report due 10/30", { zone: NY, now: SUNDAY })).toMatchObject({ title: "Lab report", dueDate: "2026-10-30" });
    expect(parseSmsCommand("Add task: register 1/5", { zone: NY, now: SUNDAY })).toMatchObject({ dueDate: "2027-01-05" });
  });

  it("keeps tasks without a trailing date undated", () => {
    expect(parseSmsCommand("Add task - study for friday quiz", { zone: NY, now: SUNDAY })).toEqual({
      type: "add",
      title: "Study for friday quiz",
      dueDate: null,
      dateText: null,
    });
  });

  it("asks for clarification instead of guessing", () => {
    expect(parseSmsCommand("Add task: essay next friday", { zone: NY, now: SUNDAY }).type).toBe("clarify");
    expect(parseSmsCommand("Add task: thing 2/30", { zone: NY, now: SUNDAY }).type).toBe("clarify");
    expect(parseSmsCommand("Add task:", { zone: NY, now: SUNDAY }).type).toBe("clarify");
  });

  it("recognizes keywords and does not confuse words that start with 'add'", () => {
    expect(parseSmsCommand("STOP", { zone: NY })).toEqual({ type: "stop" });
    expect(parseSmsCommand("unsubscribe", { zone: NY })).toEqual({ type: "stop" });
    expect(parseSmsCommand("start", { zone: NY })).toEqual({ type: "start" });
    expect(parseSmsCommand("Help", { zone: NY })).toEqual({ type: "help" });
    expect(parseSmsCommand("today", { zone: NY })).toEqual({ type: "today" });
    expect(parseSmsCommand("TASKS", { zone: NY })).toEqual({ type: "tasks" });
    expect(parseSmsCommand("DONE 1", { zone: NY })).toEqual({ type: "unsupported", keyword: "DONE" });
    expect(parseSmsCommand("Address the envelope", { zone: NY })).toEqual({ type: "unknown" });
  });
});
