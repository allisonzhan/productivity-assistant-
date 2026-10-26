import { DateTime } from "luxon";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { getCurrentUser } from "@/server/auth/session";
import { GOOGLE_CALENDAR } from "@/server/integrations/google-credentials";
import { buildSnapshot, loadBriefingInputs } from "@/server/briefings/generate";
import { MAX_SEND_ATTEMPTS } from "@/server/briefings/send";
import { listOpenTasks } from "@/server/tasks/service";
import { dateOnlyToISO } from "@/server/time";
import { retryBriefingAction, setTaskStatusAction, syncCalendarAction } from "@/app/actions";
import { Alert, Badge, Button, Card, statusTone } from "@/components/ui";
import { PhoneForms, SendBriefingForm, SimulatorForm } from "@/components/forms";

export const dynamic = "force-dynamic";

function fmt(d: Date | null | undefined, zone: string, format = "ccc LLL d, h:mm a") {
  return d ? DateTime.fromJSDate(d, { zone }).toFormat(format) : "never";
}

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    return (
      <main className="mx-auto max-w-md space-y-4 px-4 py-16">
        <h1 className="text-2xl font-semibold">Productive Assistant</h1>
        <p className="text-muted">Connect Google Calendar to import your schedule and get daily SMS briefings.</p>
        {error && <Alert tone="error">{error}</Alert>}
        <a href="/api/auth/google/start" className="inline-block rounded-md bg-accent px-4 py-2 font-medium text-white">
          Sign in with Google &amp; connect Calendar
        </a>
      </main>
    );
  }

  const zone = user.timezone;
  const simulator = env().SMS_PROVIDER === "simulator";
  const [integration, inputs, openTasks, doneTasks, latestBriefing, deliveries, inbound] = await Promise.all([
    prisma.integration.findUnique({ where: { userId_provider: { userId: user.id, provider: GOOGLE_CALENDAR } } }),
    loadBriefingInputs(user.id, zone),
    listOpenTasks(user.id),
    prisma.task.findMany({ where: { userId: user.id, status: "done", deletedAt: null }, orderBy: { completedAt: "desc" }, take: 5 }),
    prisma.briefing.findFirst({
      where: { userId: user.id, kind: { not: "sms_today" } },
      orderBy: { createdAt: "desc" },
      include: { deliveryAttempts: { orderBy: { createdAt: "asc" } } },
    }),
    prisma.deliveryAttempt.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.inboundMessage.findMany({ where: { userId: user.id }, orderBy: { receivedAt: "desc" }, take: 5 }),
  ]);
  const snapshot = buildSnapshot(inputs.events, inputs.tasks, zone, inputs.today);
  const eventsById = new Map(inputs.events.map((e) => [e.id, e]));
  const [today, ...nextDays] = snapshot.days;
  const lastAttempt = latestBriefing?.deliveryAttempts.at(-1);
  const canRetry =
    latestBriefing &&
    lastAttempt &&
    ["failed", "undelivered"].includes(lastAttempt.status) &&
    latestBriefing.deliveryAttempts.length < MAX_SEND_ATTEMPTS;

  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Today · {DateTime.now().setZone(zone).toFormat("cccc, LLLL d")}</h1>
          <p className="text-sm text-muted">{user.email} · times shown in {zone}</p>
        </div>
        <form action="/api/auth/logout" method="post">
          <Button variant="secondary">Sign out</Button>
        </form>
      </header>
      {error && <Alert tone="error">{error}</Alert>}
      {simulator && (
        <Alert tone="info">
          <strong>SMS SIMULATOR MODE.</strong> Messages are recorded locally and never sent. This is not proof of live SMS; set
          SMS_PROVIDER=twilio for real delivery.
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card
          title="Google Calendar"
          actions={
            integration && (
              <form action={syncCalendarAction} className="flex gap-2">
                <Button variant="secondary">{integration.lastError ? "Retry sync" : "Sync now"}</Button>
                <Button variant="danger" name="simulateFailure" value="1">Simulate failure</Button>
              </form>
            )
          }
        >
          {!integration ? (
            <a className="text-accent underline" href="/api/auth/google/start">Connect Google Calendar</a>
          ) : (
            <div className="space-y-2 text-sm">
              <p>
                <Badge tone={statusTone(integration.status)}>{integration.status}</Badge> Last success:{" "}
                {fmt(integration.lastSuccessAt, zone)} · Last attempt: {fmt(integration.lastSyncAt, zone)}
              </p>
              {integration.lastError && (
                <Alert tone="error">
                  Sync failed at {fmt(integration.lastErrorAt, zone)}: {integration.lastError}{" "}
                  {integration.status === "reauth_required" ? (
                    <a className="underline" href="/api/auth/google/start">Reconnect Google</a>
                  ) : (
                    "Use Retry sync."
                  )}
                </Alert>
              )}
            </div>
          )}
        </Card>

        <Card title="SMS">
          {user.phoneVerifiedAt ? (
            <p className="text-sm">
              <Badge tone="green">verified</Badge> {user.phoneE164}
              {user.smsOptOut && <> · <Badge tone="red">opted out (STOP)</Badge></>}
            </p>
          ) : (
            <PhoneForms />
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Today">
          {today.events.length === 0 && today.tasksDue.length === 0 ? (
            <p className="text-sm text-muted">Nothing scheduled today.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {today.events.map((i) => {
                const e = eventsById.get(i.id);
                return (
                  <li key={i.id}>
                    <span className="font-medium">{i.time ?? "All day"}</span> {i.title}{" "}
                    {e?.htmlLink && (
                      <a className="text-xs text-muted underline" href={e.htmlLink} target="_blank" rel="noreferrer" title={`Google event ID ${e.externalId}`}>
                        Google
                      </a>
                    )}
                  </li>
                );
              })}
              {today.tasksDue.map((t) => (
                <li key={t.id}><Badge tone="amber">due</Badge> {t.title}</li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Tasks (${openTasks.length} open)`}>
          <ul className="space-y-1.5 text-sm">
            {openTasks.map((t) => {
              const due = t.dueDate ? dateOnlyToISO(t.dueDate) : null;
              const overdue = due !== null && due < inputs.today;
              return (
                <li key={t.id} className="flex items-center gap-2">
                  <form action={setTaskStatusAction}>
                    <input type="hidden" name="taskId" value={t.id} />
                    <input type="hidden" name="status" value="done" />
                    <button aria-label={`Complete ${t.title}`} className="h-4 w-4 rounded border border-border hover:bg-accent/20" />
                  </form>
                  <span className="flex-1">{t.title}</span>
                  {due && <Badge tone={overdue ? "red" : "gray"}>{overdue ? "overdue " : ""}{DateTime.fromISO(due).toFormat("ccc LLL d")}</Badge>}
                  {t.sourceType === "sms" && <Badge tone="purple">via SMS</Badge>}
                </li>
              );
            })}
            {openTasks.length === 0 && <li className="text-muted">No open tasks. Text &quot;Add task: …&quot; to add one.</li>}
          </ul>
          {doneTasks.length > 0 && (
            <details className="mt-3 text-sm text-muted">
              <summary>Recently completed</summary>
              <ul className="mt-1 space-y-1">
                {doneTasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-2">
                    <span className="line-through">{t.title}</span>
                    <form action={setTaskStatusAction}>
                      <input type="hidden" name="taskId" value={t.id} />
                      <input type="hidden" name="status" value="open" />
                      <button className="text-xs underline">reopen</button>
                    </form>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      </div>

      <Card title="Next seven days">
        <ol className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {nextDays.map((d) => (
            <li key={d.date}>
              <p className="font-medium">{DateTime.fromISO(d.date).toFormat("cccc, LLL d")}</p>
              {d.events.length === 0 && d.tasksDue.length === 0 && <p className="text-muted">—</p>}
              <ul>
                {d.events.map((i) => (
                  <li key={i.id}>{i.time ?? "All day"} · {i.title}</li>
                ))}
                {d.tasksDue.map((t) => (
                  <li key={t.id}><Badge tone="amber">due</Badge> {t.title}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        {snapshot.overdue.length > 0 && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">Overdue: {snapshot.overdue.map((t) => t.title).join(", ")}</p>
        )}
      </Card>

      <Card title="Briefing">
        <SendBriefingForm />
        {latestBriefing && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted">Generated {fmt(latestBriefing.createdAt, zone)} from stored data</p>
            <pre className="whitespace-pre-wrap rounded-md border border-border bg-bg p-3 text-sm">{latestBriefing.content}</pre>
            <ul className="space-y-1 text-sm">
              {latestBriefing.deliveryAttempts.map((a) => (
                <li key={a.id}>
                  Attempt {a.attempt}: <Badge tone={statusTone(a.status)}>{a.status}</Badge> via {a.provider}
                  {a.error && <span className="text-red-600 dark:text-red-400"> · {a.error}</span>}
                </li>
              ))}
            </ul>
            {canRetry && (
              <form action={retryBriefingAction}>
                <input type="hidden" name="briefingId" value={latestBriefing.id} />
                <Button variant="secondary">Retry send</Button>
              </form>
            )}
          </div>
        )}
      </Card>

      {simulator && user.phoneVerifiedAt && (
        <Card title="SMS simulator (local only)">
          <SimulatorForm />
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={simulator ? "Outbox (includes SIMULATED)" : "Delivery history"}>
          <ul className="space-y-2 text-sm">
            {deliveries.map((d) => (
              <li key={d.id} className="border-b border-border pb-2 last:border-0">
                <Badge tone={statusTone(d.status)}>{d.status}</Badge> {d.purpose} → {d.to} · {fmt(d.createdAt, zone, "LLL d h:mm:ss a")}
                {d.error && <p className="text-red-600 dark:text-red-400">{d.error}</p>}
                {/* Never display real verification codes: that would bypass proof of phone ownership. */}
                {(d.provider === "simulator" || d.purpose !== "verification") && (
                  <p className="whitespace-pre-wrap text-muted">{d.body}</p>
                )}
              </li>
            ))}
            {deliveries.length === 0 && <li className="text-muted">No messages yet.</li>}
          </ul>
        </Card>
        <Card title="Inbound SMS">
          <ul className="space-y-2 text-sm">
            {inbound.map((m) => (
              <li key={m.id}>
                <Badge tone={statusTone(m.status)}>{m.status}</Badge> <Badge>{m.provider}</Badge> &quot;{m.body}&quot; ·{" "}
                {fmt(m.receivedAt, zone, "LLL d h:mm:ss a")}
              </li>
            ))}
            {inbound.length === 0 && <li className="text-muted">No inbound messages yet.</li>}
          </ul>
        </Card>
      </div>
    </main>
  );
}
