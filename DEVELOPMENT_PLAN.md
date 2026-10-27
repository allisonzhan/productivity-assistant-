# Development Plan

Derived from PRD v1.1 and the Claude Code Implementation Prompt. Conventions: [CLAUDE.md](CLAUDE.md). Status: [PROGRESS.md](PROGRESS.md).

## Current milestone: Gate 2 — runs by itself; core calendar/task product

## Phases

### Gate 0 — Repository inspection & foundation
- Inspect the repo (found: empty apart from a README), choose the stack, scaffold Next.js/TS/Tailwind/Prisma.
- `.env.example`, docker-compose Postgres, lint/typecheck/test tooling.
- Prisma schema covering the slice's entities; first migration.

### Gate 1 — Mandatory vertical slice (PASSED 2026-10-27, email channel)
| # | Step | Implementation |
|---|---|---|
| 1 | Authenticate and connect a real Google Calendar | `/api/auth/google/start` → consent (openid email profile `calendar.readonly`, offline, PKCE, state) → `/api/auth/google/callback`: verify ID token, upsert `User`, store encrypted tokens in `IntegrationCredential`, create `Session` |
| 2 | Import a real event, store the external ID | `sync/googleCalendar.ts`: windowed full sync of the primary calendar (now −1d … +30d, `singleEvents`); incremental `syncToken` in Gate 2, upsert `Event` on `(userId, provider, externalId)`, handle `cancelled`, store `SyncCursor` |
| 3 | Show the event with the correct local date/time | Dashboard server component renders Today + Seven-Day Preview in `User.timezone` via Luxon |
| 4 | Generate a briefing from DB events and tasks | `briefings/generate.ts`: deterministic, SMS-concise text; `Briefing` row stores the snapshot JSON + text |
| 5 | Send by email and record attempt/status | `delivery/email.ts` → Gmail `messages.send` from the user's mailbox to itself; `DeliveryAttempt` (queued → sent → delivered when Gmail shows it in the inbox; failed on rejection). SMS path (`delivery/sms.ts`, Twilio) is paused |
| 6 | User replies "Add task: finish reading Friday" | Reply in the briefing thread; **Check for replies** reads app-started threads via `email/replies.ts` |
| 7 | Accept only the user's own reply and create the task exactly once | From = the user's Google-verified address; skip the app's own mail; `InboundMessage` unique on `(provider, providerMessageId)`; deterministic command parser + Luxon date resolution; `Task` in the same transaction; confirmation reply in the thread |
| 8 | Refresh the dashboard; the task persists | Tasks section reads from the DB |

Cross-cutting acceptance:
- Repeated calendar sync creates no duplicate events (unique constraint + upsert; tested).
- Repeated webhook delivery (same `MessageSid`) creates no duplicate tasks (tested).
- A simulated provider failure (e.g. "Simulate failure" toggle / invalid token / Twilio error) shows a visible error with a **Retry** action, recorded in `Integration.lastError` / `DeliveryAttempt.error`.
- Acceptance uses real Google OAuth, real Gmail sends and a real reply. (SMS is paused; its local simulator is labeled SIMULATED.)

### Gate 2 — Runs by itself; core calendar/task product (CURRENT, branch `gate2-core`)
Goal: daily use with no clicks, and full task/calendar management. Ordered by daily value.

| Phase | Scope | Done when |
|---|---|---|
| A. Automation | pg-boss worker (`npm run worker`): scheduler tick every minute (morning briefing at the user's local time, optional evening briefing, DST-safe via Luxon, catch-up window, quiet hours), email reply check every 5 min, calendar sync every 15 min. `ScheduledBriefing` row unique on `(userId, kind, forDate)` so a briefing is never sent twice. Preferences UI (timezone, times, evening, quiet hours, channel). Worker heartbeat + scheduled-send status on the dashboard. | A real morning briefing arrives with no clicks; a reply becomes a task within ~5 min without clicking |
| B. Commands + tasks | `DONE <n\|title>`, `WEEK`, `MONTH` (email and SMS); task create/edit/delete, priority, due date/time on the dashboard | A week of tasks managed entirely by replies or entirely on the dashboard |
| C. Calendar | Incremental `syncToken` sync; recurring events and exceptions (`EventException`); day/week/month views; internal events | A moved instance of a weekly event is correct; Google changes appear within one sync |
| D. Finish | Delivery history page; first-run onboarding (timezone, channel, time); docs; real-account acceptance like Gate 1 | Checklist in PROGRESS.md all ✅ |

Dropped: the separate transactional email provider (Resend) — Gmail already covers email for free.

Open decisions:
- **Where the worker runs.** Phase A targets the user's laptop (free; briefings only while it runs). Free cloud hosting is evaluated after Phase A works.
- **Google 7-day refresh-token expiry** in Testing mode stops unattended runs weekly. Switching the consent screen to *In production* (unverified, personal use) should lift it; confirm current Google policy before switching.

### Gate 3 — Canvas & Gmail ingestion
Canvas API: courses, assignments, submission states, deadlines, announcements (Canvas is authoritative for its own deadlines). Gmail OAuth triage: deterministic filtering first, then structured LLM classification (critical/high/medium/low/ignored; critical needs verifiable urgency). `SourceRecord` provenance, original links, dedup, `ExtractionProposal` review queue, conflict flagging (no silent overwrite). Preserve personal notes/priorities on external updates.

### Gate 4 — Conversational assistant
A single orchestration service with schema-validated tools: getTodaySchedule, getUpcomingEvents, getTasks, createTask, updateTask, completeTask, createEvent, updateEvent, getImportantMessages, getAvailableTimeSlots, proposeWorkSessions. Clarification and confirmation flows (`PendingAction`), deterministic study-session proposals (`WorkSession`, created only after approval), prompt-injection resistance.

### Gate 5 — Additional integrations
Outlook (Microsoft Graph), Discord bot (permitted channels), optional Google Drive, Android notification companion (iOS cannot capture arbitrary notifications, so no such claim).

## Dependencies / credentials checklist
| Credential | Needed for | Gate | How to obtain |
|---|---|---|---|
| `DATABASE_URL` (Postgres) | Everything | 0 | `docker compose up -d db` or a hosted Postgres (Neon/Supabase) |
| `ENCRYPTION_KEY` (32-byte base64) | Token encryption | 1 | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth + Calendar | 1 | Google Cloud Console → enable the Calendar API → OAuth consent screen (Testing, add yourself as a test user) → Web client with redirect `${APP_URL}/api/auth/google/callback` |
| Gmail API enabled in the same Cloud project | Email briefings + replies | 1 | Cloud Console → APIs & Services → enable **Gmail API** (free) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | Outbound + inbound SMS (paused) | later | Twilio console; buy a number; set the number's inbound webhook to `${PUBLIC_URL}/api/webhooks/twilio/sms` (POST) |
| Public HTTPS URL (`PUBLIC_URL`) | Twilio webhooks reaching localhost | 1 | ngrok / Cloudflare Tunnel, or deploy (Vercel) |
| A2P 10DLC registration or toll-free verification | US SMS delivery | 1 | Twilio console; **can take days**. A trial account can only text verified numbers |
| `LLM_PROVIDER` / `ANTHROPIC_API_KEY` | NL parsing fallback, summaries | 2–4 | Optional for Gate 1 |
| Email provider (`RESEND_API_KEY`, `EMAIL_FROM`) | Email briefings | 2 | Resend/Postmark |
| Canvas token / developer key | Canvas | 3 | Institution-dependent |

## Known blockers / risks
1. **SMS provisioning (high):** US carriers require A2P 10DLC or toll-free verification; trial accounts only reach verified numbers and prefix messages. Live acceptance of steps 5–7 may be blocked until registration completes. Mitigation: a labeled simulator for development; a Twilio trial with the user's own verified number for a real round trip.
2. **Public webhook URL:** local development needs a tunnel for Twilio callbacks.
3. **Google OAuth verification:** `calendar.readonly` is a sensitive scope; the app stays in "Testing" mode (≤100 test users, 7-day refresh-token expiry for External apps in Testing). Fine for personal use; production needs verification.
4. **Canvas API access** depends on the institution (Gate 3).
5. Local Postgres requires Docker Desktop running (or a hosted DB).

## Definition of done per phase
lint + typecheck + build + tests pass; PROGRESS.md updated with evidence of what works, what is simulated and what is blocked.
