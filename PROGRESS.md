# Progress

Legend: ✅ done & verified · 🟡 implemented and tested with fakes, awaiting live verification · 🧪 simulated only · ⛔ blocked · ⬜ not started

## Current work
Gate 1 code is complete. **Next: live acceptance with real credentials** (Google OAuth client, Twilio number plus a tunnel). Gate 2 must not start until the checklist below is all ✅.

## Gate 1 checklist
| Step | Status | Evidence / what's missing |
|---|---|---|
| 1. Google OAuth + Calendar connect | 🟡 | Code + PKCE + state flow, encrypted tokens, ID-token claim checks. Smoke test: `/api/auth/google/start` returns 307 to Google with the correct scopes. **Needs a real Google client ID/secret to run end to end.** |
| 2. Import a real event with its external ID | 🟡 | `syncGoogleCalendar` upserts on `(userId, provider, externalId)`; tested with mocked Google responses. Needs a real account. |
| 3. Dashboard shows the event in local time | 🟡 | Dashboard rendered with a seeded event at the correct local time; DST/timezone unit tests pass. Needs a real event. |
| 4. Briefing from DB data | ✅ | `generateBriefing` reads only persisted rows and stores a snapshot (DB test). |
| 5. SMS send + delivery attempt/status | 🟡 / 🧪 | Twilio adapter + `DeliveryAttempt` state machine + signed status callbacks are tested with a mocked Twilio API; the simulator works locally. **Live send blocked until Twilio credentials exist (and A2P 10DLC registration for non-trial US delivery).** |
| 6. SMS reply "Add task: finish reading Friday" | 🟡 / 🧪 | Webhook route tested with correctly signed requests; simulator form works. Needs a real reply from a phone. |
| 7. Verified webhook → task created exactly once | ✅ (automated) | Signature validated against `PUBLIC_URL`; the unique `(provider, MessageSid)` constraint plus a single transaction; replayed request → 1 task, 1 reply. Live check: `scripts/replay-twilio-webhook.mjs`. |
| 8. Dashboard shows the persisted task | 🟡 | Rendered with a seeded SMS task ("via SMS" badge). Needs the live flow. |
| Duplicate sync → no duplicate events | ✅ (automated) | `calendar-sync.test.ts` |
| Duplicate webhook → no duplicate tasks | ✅ (automated) | `sms-webhook.test.ts` |
| Provider failure → visible, recoverable error | ✅ (automated + rendered) | Simulate failure sends a real request with an invalid token or sender; the error is stored on Integration/DeliveryAttempt; the dashboard shows a red alert and Retry; retry recovery is tested. |

Verification run (2026-10-25): `npm run lint` clean · `npm run typecheck` clean · `npm run build` OK · `npm test` 34/34 passed (15 unit, 19 DB integration on Postgres 16).

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
1. **Live acceptance (Gate 1):** create the Google OAuth client and the Twilio number, run a tunnel, and walk through the README checklist. Record the evidence here.
2. Gate 2 (only after 1): scheduled briefings via a pg-boss worker, quiet hours, task/event CRUD, calendar views, incremental `syncToken`, email channel, onboarding/preferences UI, DONE/WEEK/MONTH commands.

## Known bugs / limitations
- No bugs known yet.
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
