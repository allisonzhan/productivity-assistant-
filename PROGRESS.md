# Progress

Legend: ✅ done & verified · 🟡 implemented and tested with fakes, awaiting live verification · 🧪 simulated only · ⛔ blocked · ⬜ not started

## Current work
Gate 1 delivery switched from SMS to **email via the user's own Gmail** (2026-10-26, user decision: no paid services); SMS/Twilio is paused but kept. **Gate 1 live acceptance passed on 2026-10-27** with a real Google account: Calendar → dashboard → briefing → Gmail → real reply → task → dashboard. Gate 2 in progress on `gate2-core`.

## Gate 2 checklist
| Phase | Status | Evidence / what's missing |
|---|---|---|
| A. Worker + scheduled briefings + preferences | ✅ (reply leg automated only) | Live 2026-10-27: worker running against the real DB/Google; a scheduled morning briefing (time set to 15:09 local via Schedule settings) was created by the tick and sent at 19:09:07Z with no clicks, then `delivered`; 11 automatic reply checks, 0 failures. Not yet observed live: a reply to a scheduled briefing turned into a task by the 5-minute check (covered by `email-channel.test.ts` / `scheduler.test.ts`). |
| B. DONE/WEEK/MONTH + task CRUD | ⬜ | |
| C. Incremental sync, recurrence, calendar views | ⬜ | |
| D. Delivery history, onboarding, acceptance | ⬜ | |

## Gate 1 checklist
| Step | Status | Evidence / what's missing |
|---|---|---|
| 1. Google OAuth + Calendar connect | ✅ | Live 2026-10-27: real Google account signed in (test user, project in Testing). Granted scopes stored: openid, email, profile, calendar.readonly, gmail.send, gmail.readonly; refresh token stored encrypted. First sync succeeded (`JobExecution` calendar_sync succeeded). |
| 2. Import a real event with its external ID | ✅ | Live 2026-10-27: a real primary-calendar event imported with its Google event ID; 5 syncs succeeded, 0 duplicate `(userId, provider, externalId)` rows. |
| 3. Dashboard shows the event in local time | ✅ | Live 2026-10-27: event (stored 17:30Z) shown in America/New_York on the dashboard (user-confirmed). |
| 4. Briefing from DB data | ✅ | `generateBriefing` reads only persisted rows and stores a snapshot (DB test). |
| 5. Email send + delivery attempt/status | ✅ | Live 2026-10-27: 2 briefings sent via Gmail `messages.send` (`DeliveryAttempt` sent → delivered); Gmail shows both with labels SENT,INBOX and the `X-PA-Generated: briefing` header. 2 reply checks succeeded. |
| 6. Email reply "Add task: finish reading Friday" | ✅ | Live 2026-10-27 17:22Z: real Gmail reply in the briefing thread (From = the user's address, no `X-PA-Generated`), picked up by **Check for replies**; `InboundMessage` channel email, command `add`, status processed. |
| 7. Reply → task created exactly once | ✅ | Live: 1 task "Finish reading" due 2026-10-30, sourceType email; 1 `InboundMessage`, 0 duplicate `(provider, providerMessageId)`; 1 `email:task.create` audit row; confirmation "Added: Finish reading (due Fri Oct 30)" sent in the same thread and skipped as app mail. Repeat-check idempotency covered by `email-channel.test.ts`. |
| 8. Dashboard shows the persisted task | ✅ | Live: the task persists in the DB and is listed on the dashboard with the "via email" badge (user-confirmed). |
| SMS path (paused) | 🟡 / 🧪 | Twilio adapter, signed webhooks and status callbacks tested with mocks; simulator works. Not part of Gate 1 acceptance while paused. Twilio trial account exists but has no number or verified caller ID yet. |
| Duplicate sync → no duplicate events | ✅ (automated) | `calendar-sync.test.ts` |
| Duplicate webhook / reply check → no duplicate tasks | ✅ (automated) | `sms-webhook.test.ts`, `email-channel.test.ts` |
| Provider failure → visible, recoverable error | ✅ (automated) | Simulate failure sends a real request with an invalid token (Google Calendar, Gmail) or sender (Twilio); the error is stored on Integration/DeliveryAttempt; the dashboard shows a red alert and Retry; retry recovery is tested. Missing Gmail consent → `reauth_required` + Reconnect. |

Verification run (2026-10-27): `npm run lint` clean · `npm run typecheck` clean · `npm run build` OK · `npm test` 56/56 passed (25 unit, 31 DB integration on Postgres 16).

## Completed features
- Context files: CLAUDE.md, DEVELOPMENT_PLAN.md, PROGRESS.md; README with setup, providers, tests, deploy and limitations.
- Scaffold: Next.js 15, TS strict, Tailwind v4, Prisma 6 + first migration, docker-compose Postgres (plus a test DB), Vitest, ESLint.
- Auth: custom Google OAuth (PKCE, state cookie encrypted), DB sessions (hashed token, httpOnly cookie), logout.
- Calendar: Google client with bounded retries on 429/5xx, normalization (timed vs all-day date-only, cancelled, working-location skipped), windowed idempotent sync with upstream-deletion handling, token refresh, `reauth_required` on revocation.
- Briefings: deterministic snapshot + concise SMS rendering from stored data.
- SMS: Twilio REST adapter + labeled simulator; signature validation; inbound handler (exactly-once, verified-number mapping, STOP/START, HELP, TODAY, TASKS, ADD, clarification, rate limit); status callbacks with monotonic status; phone verification by OTP.
- Audit log + JobExecution records for sync, sends, and SMS-created tasks.
- Minimal dashboard: integration status/errors/retry, phone verification, Today, Tasks (complete/reopen), next seven days, briefing + attempts + retry, simulator panel, delivery history, inbound log.

## Outstanding tasks
1. ~~Live acceptance (Gate 1)~~ done 2026-10-27 (email channel).
2. Gate 2 — optional Phase A check: reply to a scheduled briefing and let the 5-minute check create the task. Then phases B–D: scheduled briefings and a scheduled reply check via a pg-boss worker, quiet hours, task/event CRUD, calendar views, incremental `syncToken`, email channel, onboarding/preferences UI, DONE/WEEK/MONTH commands.

## Known bugs / limitations
- No bugs known yet.
- Email replies are checked every 5 minutes by the worker (or on demand), over the last 7 days of briefing threads; only the first line above the quoted text is read.
- Automation runs only while `npm run worker` runs (laptop). Hosting is an open decision. Google Testing mode expires refresh tokens after 7 days.
- Catch-up is same local day only: an evening briefing due at 22:00 is not sent after midnight.
- Email `delivered` means Gmail shows the self-sent message in the inbox; it is confirmed on the next reply check.
- Sync is a windowed full sync (−1 to +30 days) of the primary calendar only.
- HELP replies come from the app; if Twilio Advanced Opt-Out also auto-replies to HELP, the user gets two messages. Revisit with a Messaging Service.
- Rate limiting is per user (10 per minute) and stored in the DB; there is no IP-level limiting yet.
- A weekday name equal to today resolves to today (e.g. "Friday" sent on a Friday). The confirmation reply echoes the resolved date.

## Decisions made
| Date | Decision | Reason |
|---|---|---|
| 2026-10-25 | Next.js 15 + Prisma 6 + Postgres, modular monolith | PRD stack; pinned to well-understood majors (Prisma 7/8 and Next 16 changed config conventions) |
| 2026-10-25 | Custom Google OAuth (code + PKCE) rather than Auth.js | One flow covers sign-in and Calendar consent; full control over encrypting refresh tokens at rest |
| 2026-10-25 | Twilio via `fetch` behind an `SmsProvider` interface, plus a labeled simulator | Provider-agnostic; the simulator is explicitly not proof of live SMS |
| 2026-10-25 | Deterministic SMS command parser for Gate 1; LLM fallback later | The PRD requires deterministic date arithmetic; ambiguity → clarification reply |
| 2026-10-25 | SMS replies sent via the REST API, not TwiML | Every outbound message gets a DeliveryAttempt with tracked status |
| 2026-10-25 | Status "accepted" (not "sent") on Twilio API success | Never claim sent until Twilio's callback says so |
| 2026-10-25 | Simulated failures use real provider requests with invalid credentials | Demonstrates genuine provider error handling, not a fake code path |
| 2026-10-25 | Jobs recorded in `JobExecution`, triggered on demand for Gate 1; pg-boss scheduler in Gate 2 | Keeps the slice simple while staying auditable |
| 2026-10-25 | Windowed full sync with soft-delete of missing events | `syncToken` can't be combined with time bounds; deferred to Gate 2 |
| 2026-10-26 | Gate 1 channel: email via the user's own Gmail (`gmail.send` + `gmail.readonly`); SMS paused | User wants no paid services; reuses the Google sign-in; Twilio needs a paid number/A2P for real use |
| 2026-10-26 | Email replies read by an on-demand check of app-started threads, not Gmail push | Push needs Cloud Pub/Sub; polling only the app's own threads keeps access narrow |
| 2026-10-26 | Shared inbound command handler for SMS and email | One exactly-once path, one parser, same STOP/rate-limit rules |
| 2026-10-27 | Worker: pg-boss cron (tick 1 min, replies 5 min, sync 15 min), "exclusive" queues; retries/backoff in our `ScheduledBriefing` row, not pg-boss | Cron + single execution from pg-boss; retry state stays visible and testable in our own table |
| 2026-10-27 | Catch-up window 4 h; quiet hours defer automated sends only (command replies stay immediate) | A late briefing is still useful in the morning; a user who just texted expects an answer |
| 2026-10-27 | Worker runs locally first (`tsx --conditions=react-server`) | Free; hosting decided after Phase A works |
