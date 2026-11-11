import { DateTime } from "luxon";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { getCurrentUser } from "@/server/auth/session";
import { clearAgentRunMarkAction } from "@/app/actions";
import { Badge, Button, Card } from "@/components/ui";
import { ReviewForm } from "@/components/forms";
import type { ToolCallRecord } from "@/server/ai/agent";
import type { ProposedAction } from "@/server/ai/tools";

export const dynamic = "force-dynamic";

/** Every reply I sent and what the assistant did with it, so I can mark it right or wrong for `npm run eval`. */
export default async function RepliesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  const zone = user.timezone;
  const [runs, tasks, counts] = await Promise.all([
    prisma.agentRun.findMany({ where: { userId: user.id }, orderBy: { receivedAt: "desc" }, take: 50 }),
    prisma.task.findMany({ where: { userId: user.id, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, title: true } }),
    prisma.agentRun.groupBy({ by: ["verdict"], where: { userId: user.id, kind: "agent" }, _count: true }),
  ]);
  const count = (v: string | null) => counts.find((c) => c.verdict === v)?._count ?? 0;

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Replies</h1>
        <Link className="text-accent underline" href="/">Dashboard</Link>
      </div>
      <p className="text-sm text-muted">
        Agent replies: {count("right")} marked right · {count("wrong")} marked wrong · {count(null)} unmarked. Marked replies are replayed by{" "}
        <code>npm run eval</code>. Mark a reply wrong and say what it should have done to make it a test case.
      </p>
      {!runs.length && <p className="text-sm">No replies yet. Reply to a briefing email to get started.</p>}
      {runs.map((run) => {
        const calls = (run.toolCalls as ToolCallRecord[] | null) ?? [];
        const proposed = (run.proposedActions as ProposedAction[] | null) ?? [];
        return (
          <Card
            key={run.id}
            title={DateTime.fromJSDate(run.receivedAt, { zone }).toFormat("ccc LLL d, h:mm a")}
            actions={
              <span className="flex items-center gap-2">
                <Badge tone={run.kind === "agent" ? "purple" : "gray"}>{run.kind === "agent" ? "assistant" : "command"}</Badge>
                {run.verdict && <Badge tone={run.verdict === "right" ? "green" : "red"}>{run.verdict}</Badge>}
                {run.error && <Badge tone="red">error</Badge>}
              </span>
            }
          >
            <div className="space-y-2 text-sm">
              <p className="whitespace-pre-wrap"><strong>You:</strong> {run.input}</p>
              {calls.length > 0 && (
                <p className="text-muted">
                  Looked up: {calls.map((c) => `${c.name}${c.isError ? " (error)" : ""}`).join(", ")}
                </p>
              )}
              {proposed.length > 0 && <p><strong>Proposed:</strong> {proposed.map((p) => p.summary).join("; ")}</p>}
              <p className="whitespace-pre-wrap"><strong>Reply:</strong> {run.reply ?? "(none)"}</p>
              {run.error && <p className="text-red-600 dark:text-red-400">Error: {run.error}</p>}
              {run.note && <p className="text-muted">Your note: {run.note}</p>}
              {run.kind === "agent" &&
                (run.verdict ? (
                  <form action={clearAgentRunMarkAction}>
                    <input type="hidden" name="runId" value={run.id} />
                    <Button variant="secondary">Change mark</Button>
                  </form>
                ) : (
                  <ReviewForm runId={run.id} tasks={tasks} verdict={run.verdict} />
                ))}
            </div>
          </Card>
        );
      })}
    </main>
  );
}
