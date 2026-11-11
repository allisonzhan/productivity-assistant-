import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { CanvasConnectError, connectCanvas, syncCanvas } from "@/server/sync/canvas-sync";
import { generateBriefing, type BriefingSnapshot } from "@/server/briefings/generate";
import { hasDb, makeUser, resetDb } from "../helpers";
import { CANVAS_TEST_URL, CANVAS_TOKEN, fakeCanvas } from "../fake-canvas";

const now = new Date("2026-11-10T13:00:00Z"); // 8:00am in New York
const opts = (canvas: ReturnType<typeof fakeCanvas>, extra: { now?: Date } = {}) => ({ baseUrl: CANVAS_TEST_URL, fetchImpl: canvas.fetchImpl, now, ...extra });

function setup() {
  const canvas = fakeCanvas();
  canvas.courses.set(101, {
    name: "ECE 2564 Embedded Systems",
    assignments: [
      { id: 1, name: "Lab 5", due_at: "2026-11-12T04:59:00Z", html_url: "https://canvas.example.test/a/1" }, // Wed 11:59pm local
      { id: 2, name: "Homework 7", due_at: "2026-11-14T04:59:00Z", submission: { submitted_at: "2026-11-09T20:00:00Z", workflow_state: "submitted" } },
      { id: 3, name: "Old quiz", due_at: "2026-09-01T04:59:00Z" }, // outside the window
      { id: 4, name: "Unpublished draft", due_at: "2026-11-15T04:59:00Z", published: false },
      { id: 5, name: "Participation", due_at: null },
    ],
  });
  canvas.courses.set(202, { name: "MATH 2214", assignments: [{ id: 9, name: "Problem set 6", due_at: "2026-11-13T04:59:00Z" }] });
  return canvas;
}

describe.skipIf(!hasDb)("Canvas sync", () => {
  beforeEach(resetDb);

  it("validates and stores the token encrypted, then imports assignments in the window across pages", async () => {
    const user = await makeUser();
    const canvas = setup();
    await expect(connectCanvas(user.id, "1234~wrongwrongwrongwrongwrong", opts(canvas))).rejects.toBeInstanceOf(CanvasConnectError);
    expect(await prisma.integration.count()).toBe(0);

    const result = await connectCanvas(user.id, ` ${CANVAS_TOKEN} `, opts(canvas));
    expect(result).toMatchObject({ ok: true, courses: 2, upserted: 4 });
    const cred = await prisma.integrationCredential.findFirstOrThrow();
    expect(cred.accessTokenEnc).not.toContain(CANVAS_TOKEN);
    expect(decrypt(cred.accessTokenEnc)).toBe(CANVAS_TOKEN);

    const tasks = await prisma.task.findMany({ where: { userId: user.id }, orderBy: { externalId: "asc" } });
    expect(tasks.map((t) => [t.externalId, t.title, t.courseName, !!t.externalSubmittedAt])).toEqual([
      ["assignment:1", "Lab 5", "ECE 2564 Embedded Systems", false],
      ["assignment:2", "Homework 7", "ECE 2564 Embedded Systems", true],
      ["assignment:5", "Participation", "ECE 2564 Embedded Systems", false],
      ["assignment:9", "Problem set 6", "MATH 2214", false],
    ]);
    expect(tasks.every((t) => t.sourceType === "canvas")).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "canvas.sync" } })).toBe(1);
  });

  it("is idempotent and keeps my notes, priority and done status when Canvas changes a deadline", async () => {
    const user = await makeUser();
    const canvas = setup();
    await connectCanvas(user.id, CANVAS_TOKEN, opts(canvas));
    const lab = await prisma.task.findFirstOrThrow({ where: { externalId: "assignment:1" } });
    await prisma.task.update({ where: { id: lab.id }, data: { notes: "bring the board", priority: "high" } });
    const ps = await prisma.task.findFirstOrThrow({ where: { externalId: "assignment:9" } });
    await prisma.task.update({ where: { id: ps.id }, data: { status: "done", completedAt: now } });

    // Canvas moves the lab deadline and renames it.
    canvas.courses.get(101)!.assignments[0] = { id: 1, name: "Lab 5 (extended)", due_at: "2026-11-13T04:59:00Z" };
    await syncCanvas(user.id, opts(canvas));
    await syncCanvas(user.id, opts(canvas));

    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(4);
    const after = await prisma.task.findUniqueOrThrow({ where: { id: lab.id } });
    expect(after).toMatchObject({ title: "Lab 5 (extended)", notes: "bring the board", priority: "high", status: "open" });
    expect(after.dueAt?.toISOString()).toBe("2026-11-13T04:59:00.000Z");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: ps.id } })).status).toBe("done");
  });

  it("soft-deletes assignments Canvas no longer returns", async () => {
    const user = await makeUser();
    const canvas = setup();
    await connectCanvas(user.id, CANVAS_TOKEN, opts(canvas));
    canvas.courses.delete(202);
    const result = await syncCanvas(user.id, opts(canvas));
    expect(result).toMatchObject({ ok: true, removed: 1 });
    expect((await prisma.task.findFirstOrThrow({ where: { externalId: "assignment:9" } })).deletedAt).not.toBeNull();
  });

  it("shows unsubmitted assignments with their course in the briefing and hides submitted ones", async () => {
    const user = await makeUser();
    const canvas = setup();
    await connectCanvas(user.id, CANVAS_TOKEN, opts(canvas));
    const briefing = await generateBriefing(user.id, "adhoc", now);
    const s = briefing.snapshot as unknown as BriefingSnapshot;
    const due = s.days.flatMap((d) => d.tasksDue.map((t) => [d.date, t.title, t.course, t.time]));
    expect(due).toEqual([
      ["2026-11-11", "Lab 5", "ECE 2564 Embedded Systems", "11:59pm"],
      ["2026-11-12", "Problem set 6", "MATH 2214", "11:59pm"],
    ]);
    expect(JSON.stringify(s)).not.toContain("Homework 7");
  });

  it("records a revoked token as reauth_required and transient errors as a visible, retryable error", async () => {
    const user = await makeUser();
    const canvas = setup();
    await connectCanvas(user.id, CANVAS_TOKEN, opts(canvas));

    canvas.state.failNext = 5; // more than the bounded retries
    const failed = await syncCanvas(user.id, opts(canvas));
    expect(failed.ok).toBe(false);
    let integration = await prisma.integration.findFirstOrThrow({ where: { provider: "canvas" } });
    expect(integration.status).toBe("error");
    expect(integration.lastError).toContain("503");
    expect(await prisma.task.count({ where: { deletedAt: { not: null } } })).toBe(0); // failure never deletes

    canvas.state.failNext = 0;
    expect((await syncCanvas(user.id, opts(canvas))).ok).toBe(true);

    await prisma.integrationCredential.updateMany({ data: { accessTokenEnc: (await import("@/server/crypto")).encrypt("1234~revokedrevokedrevokedrevoked") } });
    await syncCanvas(user.id, opts(canvas));
    integration = await prisma.integration.findFirstOrThrow({ where: { provider: "canvas" } });
    expect(integration.status).toBe("reauth_required");
    expect(integration.lastError).toContain("Paste a new access token");
  });
});
