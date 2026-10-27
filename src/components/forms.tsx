"use client";

import { useActionState, useState } from "react";
import {
  checkEmailRepliesAction,
  confirmPhoneAction,
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
