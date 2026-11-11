import { prisma } from "@/server/db";
import { audit } from "@/server/audit/log";
import { decrypt, encrypt } from "@/server/crypto";
import { env } from "@/server/env";
import { errorMessage, runJob } from "@/server/jobs/run";
import { CanvasApiError, canvasClient, type CanvasAssignment } from "@/server/canvas/client";

export const CANVAS = "canvas";
const WINDOW_PAST_DAYS = 7;
const WINDOW_FUTURE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export class CanvasConnectError extends Error {}

export type CanvasSyncResult =
  | { ok: true; courses: number; fetched: number; upserted: number; removed: number }
  | { ok: false; error: string };

type Opts = { fetchImpl?: typeof fetch; now?: Date; baseUrl?: string };

function baseUrl(opts: Opts) {
  return opts.baseUrl ?? env().CANVAS_BASE_URL;
}

/** Validates the personal access token against Canvas, then stores it encrypted and runs a first sync. */
export async function connectCanvas(userId: string, rawToken: string, opts: Opts = {}) {
  const token = rawToken.trim();
  if (token.length < 20 || /\s/.test(token)) throw new CanvasConnectError("That doesn't look like a Canvas access token.");
  try {
    await canvasClient({ baseUrl: baseUrl(opts), token, fetchImpl: opts.fetchImpl }).self();
  } catch (err) {
    if (err instanceof CanvasApiError && err.status === 401) throw new CanvasConnectError("Canvas rejected that token (401). Create a new one and paste it again.");
    throw new CanvasConnectError(`Couldn't reach Canvas: ${errorMessage(err)}`);
  }
  await prisma.$transaction(async (tx) => {
    const integration = await tx.integration.upsert({
      where: { userId_provider: { userId, provider: CANVAS } },
      create: { userId, provider: CANVAS, status: "connected" },
      update: { status: "connected", lastError: null, lastErrorAt: null },
    });
    await tx.integrationCredential.upsert({
      where: { integrationId: integration.id },
      create: { integrationId: integration.id, accessTokenEnc: encrypt(token), scope: "canvas:personal_access_token" },
      update: { accessTokenEnc: encrypt(token), refreshTokenEnc: null, expiresAt: null },
    });
    await audit({ userId, actor: "user", action: "canvas.connect", entityType: "Integration", entityId: integration.id }, tx);
  });
  return syncCanvas(userId, opts);
}

/** Forgets the token. Imported assignments stay (with any notes) until the user deletes them. */
export async function disconnectCanvas(userId: string) {
  const integration = await prisma.integration.findUnique({ where: { userId_provider: { userId, provider: CANVAS } } });
  if (!integration) return;
  await prisma.$transaction([
    prisma.integrationCredential.deleteMany({ where: { integrationId: integration.id } }),
    prisma.integration.update({ where: { id: integration.id }, data: { status: "disconnected" } }),
    prisma.auditLog.create({ data: { userId, actor: "user", action: "canvas.disconnect", entityType: "Integration", entityId: integration.id } }),
  ]);
}

export function isSubmitted(a: CanvasAssignment): boolean {
  const s = a.submission;
  return !!s && (!!s.submitted_at || !!s.excused || ["submitted", "graded", "pending_review"].includes(s.workflow_state ?? ""));
}

/**
 * Idempotent import of active-course assignments. Upserts on (userId, "canvas", "assignment:<id>").
 * Canvas is authoritative for title, due time, link, course and submission; notes, priority and
 * done status belong to the user and are never overwritten. Assignments Canvas no longer returns
 * (deleted, unpublished, course ended) are soft-deleted.
 */
export async function syncCanvas(userId: string, opts: Opts = {}): Promise<CanvasSyncResult> {
  const integration = await prisma.integration.findUnique({
    where: { userId_provider: { userId, provider: CANVAS } },
    include: { credential: true },
  });
  if (!integration?.credential) return { ok: false, error: "Canvas is not connected." };
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - WINDOW_PAST_DAYS * DAY_MS);
  const to = new Date(now.getTime() + WINDOW_FUTURE_DAYS * DAY_MS);

  try {
    const result = await runJob({ type: "canvas_sync", userId }, async () => {
      const client = canvasClient({ baseUrl: baseUrl(opts), token: decrypt(integration.credential!.accessTokenEnc), fetchImpl: opts.fetchImpl });
      const courses = await client.activeCourses();
      const seen = new Set<string>();
      let fetched = 0;
      let upserted = 0;
      for (const course of courses) {
        const assignments = await client.assignments(course.id);
        fetched += assignments.length;
        for (const a of assignments) {
          if (a.published === false) continue;
          const externalId = `assignment:${a.id}`;
          seen.add(externalId);
          const dueAt = a.due_at ? new Date(a.due_at) : null;
          if (dueAt && (dueAt < from || dueAt > to)) continue;
          const owned = {
            title: a.name.slice(0, 300),
            dueAt,
            dueDate: null,
            htmlLink: a.html_url ?? null,
            courseName: (course.name ?? course.course_code ?? "").slice(0, 200) || null,
            externalSubmittedAt: isSubmitted(a) ? (a.submission?.submitted_at ? new Date(a.submission.submitted_at) : now) : null,
            deletedAt: null,
          };
          await prisma.task.upsert({
            where: { userId_externalProvider_externalId: { userId, externalProvider: CANVAS, externalId } },
            create: { userId, externalProvider: CANVAS, externalId, sourceType: "canvas", verification: "confirmed", ...owned },
            update: owned,
          });
          upserted++;
        }
      }
      const removed = await prisma.task.updateMany({
        where: { userId, externalProvider: CANVAS, deletedAt: null, externalId: { notIn: [...seen] } },
        data: { deletedAt: now },
      });
      await audit({ userId, actor: "sync", action: "canvas.sync", entityType: "Integration", entityId: integration.id, metadata: { courses: courses.length, fetched, upserted, removed: removed.count } });
      return { ok: true as const, courses: courses.length, fetched, upserted, removed: removed.count };
    });
    await prisma.integration.update({
      where: { id: integration.id },
      data: { status: "connected", lastSyncAt: now, lastSuccessAt: now, lastError: null, lastErrorAt: null },
    });
    return result;
  } catch (err) {
    const reauth = err instanceof CanvasApiError && err.status === 401;
    const message = reauth ? "Canvas token is invalid or expired. Paste a new access token." : errorMessage(err);
    await prisma.integration.update({
      where: { id: integration.id },
      data: { status: reauth ? "reauth_required" : "error", lastSyncAt: now, lastError: message, lastErrorAt: now },
    });
    return { ok: false, error: message };
  }
}

/** Periodic sync for everyone with a usable Canvas token. */
export async function syncAllCanvas(now: Date = new Date(), opts: Omit<Opts, "now"> = {}) {
  const integrations = await prisma.integration.findMany({
    where: { provider: CANVAS, status: { notIn: ["reauth_required", "disconnected"] } },
    select: { userId: true },
  });
  const results = [];
  for (const { userId } of integrations) results.push({ userId, ...(await syncCanvas(userId, { ...opts, now })) });
  return results;
}
