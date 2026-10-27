# Progress

Legend: ✅ done & verified · 🟡 implemented and tested with fakes, awaiting live verification · 🧪 simulated only · ⛔ blocked · ⬜ not started

## Current work
Gate 1 delivery switched from SMS to **email via the user's own Gmail** (2026-10-26, user decision: no paid services); SMS/Twilio is paused but kept. **Next: live acceptance with a real Google account** (Calendar + Gmail API enabled, user added as a test user). Live so far (2026-10-27): sign-in, calendar import, dashboard, briefing generation and Gmail send/delivery. Remaining live step: a real reply → task. Gate 2 must not start until the checklist below is all ✅.

## Gate 1 checklist
| Step | Status | Evidence / what's missing |
|---|---|---|
| 1. Google OAuth + Calendar connect | ✅ | Live 2026-10-27: real Google account signed in (test user, project in Testing). Granted scopes stored: openid, email, profile, calendar.readonly, gmail.send, gmail.readonly; refresh token stored encrypted. First sync succeeded (`JobExecution` calendar_sync succeeded). |
| 2. Import a real event with its external ID | ✅ | Live 2026-10-27: a real primary-calendar event imported with its Google event ID; 5 syncs succeeded, 0 duplicate `(userId, provider, externalId)` rows. |
| 3. Dashboard shows the event in local time | ✅ | Live 2026-10-27: event (stored 17:30Z) shown in America/New_York on the dashboard (user-confirmed). |
| 4. Briefing from DB data | ✅ | `generateBriefing` reads only persisted rows and stores a snapshot (DB test). |
| 5. Email send + delivery attempt/status | ✅ | Live 2026-10-27: 2 briefings sent via Gmail `messages.send` (`DeliveryAttempt` sent → delivered); Gmail shows both with labels SENT,INBOX and the `X-PA-Generated: briefing` header. 2 reply checks succeeded. |
| 6. Email reply "Add task: finish reading Friday" | ⬜ | Live check 2026-10-27 17:19Z: no reply present in either briefing thread in Gmail (thread metadata shows only the briefing), so no `InboundMessage`/task yet. Re-run: reply in the briefing thread, then **Check for replies**. Code path tested against a fake Gmail API. |
| 7. Reply → task created exactly once | ✅ (automated) | Unique `(provider, providerMessageId)` + one transaction; the app's own mail is skipped (`X-PA-Generated` + own IDs); repeated checks → 1 task, 1 confirmation (`email-channel.test.ts`). |
| 8. Dashboard shows the persisted task | 🟡 | "via email" badge. Waits on step 6 live. |
| SMS path (paused) | 🟡 / 🧪 | Twilio adapter, signed webhooks and status callbacks tested with mocks; simulator works. Not part of Gate 1 acceptance while paused. Twilio trial account exists but has no number or verified caller ID yet. |
| Duplicate sync → no duplicate events | ✅ (automated) | `calendar-sync.test.ts` |
| Duplicate webhook / reply check → no duplicate tasks | ✅ (automated) | `sms-webhook.test.ts`, `email-channel.test.ts` |
| Provider failure → visible, recoverable error | ✅ (automated) | Simulate failure sends a real request with an invalid token (Google Calendar, Gmail) or sender (Twilio); the error is stored on Integration/DeliveryAttempt; the dashboard shows a red alert and Retry; retry recovery is tested. Missing Gmail consent → `reauth_required` + Reconnect. |

Verification run (2026-10-26): `npm run lint` clean · `npm run typecheck` clean · `npm run build` OK · `npm test` 44/44 passed (20 unit, 24 DB integration on Postgres 16).

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
1. **Live acceptance (Gate 1):** enable the Gmail API in the Cloud project, fix the OAuth test-user 403 (`access_denied`; check the project number matches the client ID), sign in, and walk through the README checklist. Record the evidence here.
2. Gate 2 (only after 1): scheduled briefings and a scheduled reply check via a pg-boss worker, quiet hours, task/event CRUD, calendar views, incremental `syncToken`, email channel, onboarding/preferences UI, DONE/WEEK/MONTH commands.

## Known bugs / limitations
- No bugs known yet.
- Email replies are checked on demand (**Check for replies**) in Gate 1, over the last 7 days of briefing threads; only the first line above the quoted text is read.
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
