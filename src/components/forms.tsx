"use client";

import { useActionState, useState } from "react";
import {
  markAgentRunAction,
  connectCanvasAction,
  checkEmailRepliesAction,
  confirmPhoneAction,
  savePreferencesAction,
  sendBriefingAction,
  simulateInboundAction,
  startPhoneAction,
  type FormState,
} from "@/app/actions";
import { Button, inputClass } from "@/components/ui";

function Message({ state }: { state: FormState }) {
  if (!state.message) return null;
  return (
    <p role={state.ok ? "status" : "alert"} className={`mt-2 text-sm ${state.ok ? "text-muted" : "text-red-600 dark:text-red-400"}`}>
      {state.message}
    </p>
  );
}

export function PhoneForms() {
  const [startState, startAction, starting] = useActionState(startPhoneAction, {});
  const [confirmState, confirmAction, confirming] = useActionState(confirmPhoneAction, {});
  return (
    <div className="space-y-3">
      <form action={startAction} className="flex gap-2">
        <label className="sr-only" htmlFor="phone">Phone number</label>
        <input id="phone" name="phone" type="tel" placeholder="+1 555 555 0100" required className={inputClass} />
        <Button disabled={starting}>Send code</Button>
      </form>
      <Message state={startState} />
      <form action={confirmAction} className="flex gap-2">
        <label className="sr-only" htmlFor="code">Verification code</label>
        <input id="code" name="code" inputMode="numeric" placeholder="6-digit code" required className={inputClass} />
        <Button variant="secondary" disabled={confirming}>Verify</Button>
      </form>
      <Message state={confirmState} />
    </div>
  );
}

export function ReviewForm({ runId, tasks, verdict }: { runId: string; tasks: { id: string; title: string }[]; verdict: string | null }) {
  const [state, action, pending] = useActionState(markAgentRunAction, {});
  const [wrong, setWrong] = useState(verdict === "wrong");
  const [should, setShould] = useState("");
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="runId" value={runId} />
      <div className="flex flex-wrap items-center gap-2">
        <Button name="verdict" value="right" variant="secondary" disabled={pending} onClick={() => setWrong(false)}>
          ✓ Right
        </Button>
        <Button type="button" variant={wrong ? "danger" : "secondary"} onClick={() => setWrong(true)}>
          ✗ Wrong…
        </Button>
        <label className="sr-only" htmlFor={`note-${runId}`}>Note</label>
        <input id={`note-${runId}`} name="note" placeholder="Note (optional)" className={inputClass} />
      </div>
      {wrong && (
        <div className="space-y-2 rounded-md border border-border p-2">
          <label className="block text-sm">
            It should have…{" "}
            <select name="should" value={should} onChange={(e) => setShould(e.target.value)} className={inputClass}>
              <option value="">(just mark it wrong)</option>
              <option value="answer">answered without changing anything</option>
              <option value="clarify">asked me a clarifying question</option>
              <option value="create">proposed adding a task</option>
              <option value="update_due">proposed moving a task to a date</option>
              <option value="complete">proposed marking a task done</option>
            </select>
          </label>
          {(should === "update_due" || should === "complete") && (
            <label className="block text-sm">
              Task{" "}
              <select name="taskId" className={inputClass} required>
                <option value="">Choose…</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
            </label>
          )}
          {should === "create" && <input name="title" placeholder="Task title" required className={inputClass} />}
          {(should === "create" || should === "update_due") && (
            <input name="dateText" placeholder='Date, e.g. "Sunday" or "11/15" (as of when you replied)' className={inputClass} />
          )}
          <Button name="verdict" value="wrong" variant="danger" disabled={pending}>Save as wrong</Button>
        </div>
      )}
      <Message state={state} />
    </form>
  );
}

export function CanvasTokenForm({ replacing }: { replacing?: boolean }) {
  const [state, action, pending] = useActionState(connectCanvasAction, {});
  return (
    <div>
      <form action={action} className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="canvas-token">Canvas access token</label>
        <input
          id="canvas-token"
          name="token"
          type="password"
          autoComplete="off"
          placeholder={replacing ? "Paste a new access token" : "Paste your Canvas access token"}
          required
          className={inputClass}
        />
        <Button disabled={pending}>{pending ? "Checking…" : replacing ? "Replace token" : "Connect Canvas"}</Button>
      </form>
      <Message state={state} />
    </div>
  );
}

export function SendBriefingForm() {
  const [state, action, pending] = useActionState(sendBriefingAction, {});
  return (
    <div>
      <form action={action} className="flex flex-wrap gap-2">
        <Button disabled={pending}>Generate &amp; send briefing</Button>
        <Button variant="danger" name="simulateFailure" value="1" disabled={pending}>
          Send with simulated failure
        </Button>
      </form>
      <Message state={state} />
    </div>
  );
}

export type SettingsValues = {
  timezone: string;
  morningEnabled: boolean;
  morningTime: string;
  eveningEnabled: boolean;
  eveningTime: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
};

export function SettingsForm({ initial }: { initial: SettingsValues }) {
  const [state, action, pending] = useActionState(savePreferencesAction, {});
  const row = "flex flex-wrap items-center gap-2";
  const time = `${inputClass} w-auto`;
  return (
    <form action={action} className="space-y-3 text-sm">
      <div className={row}>
        <label htmlFor="timezone" className="w-28">Timezone</label>
        <input id="timezone" name="timezone" defaultValue={initial.timezone} required className={`${inputClass} max-w-xs`} />
      </div>
      <div className={row}>
        <label className="flex w-28 items-center gap-1.5">
          <input type="checkbox" name="morningEnabled" defaultChecked={initial.morningEnabled} /> Morning
        </label>
        <label className="sr-only" htmlFor="morningTime">Morning briefing time</label>
        <input id="morningTime" name="morningTime" type="time" defaultValue={initial.morningTime} required className={time} />
      </div>
      <div className={row}>
        <label className="flex w-28 items-center gap-1.5">
          <input type="checkbox" name="eveningEnabled" defaultChecked={initial.eveningEnabled} /> Evening
        </label>
        <label className="sr-only" htmlFor="eveningTime">Evening briefing time</label>
        <input id="eveningTime" name="eveningTime" type="time" defaultValue={initial.eveningTime} required className={time} />
      </div>
      <div className={row}>
        <span className="w-28">Quiet hours</span>
        <label className="sr-only" htmlFor="quietHoursStart">Quiet hours start</label>
        <input id="quietHoursStart" name="quietHoursStart" type="time" defaultValue={initial.quietHoursStart ?? ""} className={time} />
        <span aria-hidden>to</span>
        <label className="sr-only" htmlFor="quietHoursEnd">Quiet hours end</label>
        <input id="quietHoursEnd" name="quietHoursEnd" type="time" defaultValue={initial.quietHoursEnd ?? ""} className={time} />
      </div>
      <p className="text-xs text-muted">Nothing automated is sent during quiet hours. A briefing missed while the worker was off still goes out up to 4 hours late.</p>
      <Button disabled={pending}>Save schedule</Button>
      <Message state={state} />
    </form>
  );
}

export function CheckRepliesForm() {
  const [state, action, pending] = useActionState(checkEmailRepliesAction, {});
  return (
    <div>
      <form action={action}>
        <Button variant="secondary" disabled={pending}>{pending ? "Checking…" : "Check for replies"}</Button>
      </form>
      <Message state={state} />
    </div>
  );
}

export function SimulatorForm() {
  const [state, action, pending] = useActionState(simulateInboundAction, {});
  const [body, setBody] = useState("Add task: finish reading Friday");
  return (
    <div>
      <form action={action} className="space-y-2">
        <label className="block text-sm" htmlFor="sim-body">Simulated inbound SMS from your verified number</label>
        <input id="sim-body" name="body" value={body} onChange={(e) => setBody(e.target.value)} className={inputClass} />
        <input type="hidden" name="replayId" value={state.messageId ?? ""} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending}>Send simulated reply</Button>
          <Button variant="secondary" name="replay" value="1" disabled={pending || !state.messageId}>
            Replay last message ID (duplicate test)
          </Button>
        </div>
      </form>
      <Message state={state} />
    </div>
  );
}
