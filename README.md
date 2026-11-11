# productivity-assistant

A student-first daily briefing you can talk back to. Every morning it emails you, from your own Gmail, a briefing built from your Google Calendar, your tasks and your Canvas assignments: today's schedule, what's due and overdue, your free time with a suggested focus, and the next seven days. You manage your day by replying to that email, either with fixed commands (`Add task: finish reading Friday`, `TODAY`, `TASKS`) or in plain language ("what's due this week?", "push my essay to Sunday", "done with the lab"). Changes always wait for your **YES**.

**Status** (details and evidence in [PROGRESS.md](PROGRESS.md)):
- Gate 1, the end-to-end loop (Calendar → briefing → Gmail → reply → task), passed live on 2026-10-27.
- Gate 2 Phase A (the worker that sends the morning briefing and checks replies on a schedule) has run live.
- The gate-ai-upgrade steps (richer briefing, Canvas deadlines, natural-language replies, reply-quality eval) are built and pass automated tests against fake Google/Canvas/Claude servers. **Their live verification is still pending.**

Rules for contributors (human or AI): [CLAUDE.md](CLAUDE.md). Roadmap: [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md).

## Stack
Next.js 15 (App Router) · React 19 · TypeScript · PostgreSQL 16 · Prisma 6 · pg-boss · Tailwind v4 · Luxon · Zod · Vitest.
- Google OAuth, Calendar, Gmail and Canvas are called over REST (no SDKs).
- Claude is called through `@anthropic-ai/sdk`.
- Twilio is called over REST; SMS is implemented but paused.

## Setup
```bash
docker compose up -d db        # Postgres on :5432, also creates productive_assistant_test
npm install                    # runs prisma generate
cp .env.example .env           # fill in values (see below)
npx prisma migrate dev         # apply migrations
npm run dev                    # web app: http://localhost:3000
npm run worker                 # second terminal: scheduled briefings, reply checks, syncs
```
npm 11 may ask you to approve install scripts. Approve them with `npm approve-scripts @prisma/client @prisma/engines prisma esbuild unrs-resolver`. On PowerShell, use `npm.cmd` if `npm` is blocked by the execution policy.

Then, in the app:
1. Sign in with Google.
2. Set your morning time under **Schedule settings**.
3. Optionally paste a Canvas access token on the **Canvas** card.

## Environment variables
| Variable | Purpose |
|---|---|
| `APP_URL` | Browser base URL. The OAuth redirect is `${APP_URL}/api/auth/google/callback`; briefing emails link to `${APP_URL}/replies` |
| `DEFAULT_TIMEZONE` | Fallback IANA zone if the Google calendar's timezone can't be read |
| `DATABASE_URL` / `TEST_DATABASE_URL` | App database and a separate test database (the tests wipe it) |
| `ENCRYPTION_KEY` | 32-byte base64 key for AES-256-GCM encryption of OAuth and Canvas tokens. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth web client |
| `CANVAS_BASE_URL` | Your Canvas site (default `https://canvas.vt.edu`). The access token itself is pasted in the app and stored encrypted |
| `ANTHROPIC_API_KEY` | Enables natural-language replies. Without it, replies use the fixed commands only |
| `ANTHROPIC_MODEL` | Model for replies and `npm run eval` (default `claude-opus-5-5`) |
| `AGENT_ENABLED` | `true` (default) or `false` to turn natural-language replies off |
| `PUBLIC_URL`, `SMS_PROVIDER`, `TWILIO_*` | SMS only (paused). See [Twilio](#twilio-paused) |

## Provider configuration
### Google
1. In Google Cloud Console, create a project and enable the **Google Calendar API** and the **Gmail API**.
2. Set up the OAuth consent screen (External) and **publish it ("In production")**. In *Testing* mode, Google expires refresh tokens after 7 days, which silently stops the morning briefing (this caused a real outage on 2026-11-02). An unverified app in production is fine for personal use; you will see an "unverified app" warning when you sign in.
3. Create an OAuth client of type *Web application* with the redirect URI `http://localhost:3000/api/auth/google/callback` (plus your deployed URL).
4. The app requests the scopes `openid email profile calendar.readonly gmail.send gmail.readonly`. Gmail is used only to send briefings from your mailbox to yourself and to read replies in the threads the app started.

If Google access lapses anyway, the dashboard shows **Reconnect Google** and the worker prints an hourly warning.

### Canvas
In Canvas, open **Account → Settings → New Access Token**, then paste the token on the dashboard's **Canvas** card.
- The token is checked against Canvas and stored encrypted.
- Assignments from active courses (due from 7 days ago to 60 days ahead) sync hourly, and again right before each scheduled briefing.
- Canvas owns each assignment's title, due time, link, course and submission state. Your notes, priority and done status are kept on every re-sync.
- Submitted assignments are hidden from the briefing.

### Claude (natural-language replies)
Create an API key at console.anthropic.com and set `ANTHROPIC_API_KEY` in `.env`, then restart the worker. A short reply costs a few cents at most.

### Twilio (paused)
Only needed if you switch briefings to SMS.
1. Buy an SMS-capable number.
2. Point its inbound webhook (HTTP POST) at `${PUBLIC_URL}/api/webhooks/twilio/sms`.
3. US delivery needs A2P 10DLC registration.

For local development, use a tunnel (`ngrok http 3000`) as `PUBLIC_URL`. With `SMS_PROVIDER=simulator`, SMS runs against a local outbox labeled SIMULATED and **does not prove live SMS**.

## Using it
### The morning briefing
At your chosen time (your timezone, DST-safe), the worker emails you:
- Today's events.
- What's due today and what's overdue.
- Free blocks of 30+ minutes, plus a **suggested** focus that pairs your most urgent tasks with your biggest free blocks. This is computed deterministically, not by an LLM.
- The next seven days, with each deadline listed by day and Canvas items tagged with their course.

Tasks are numbered, so you can refer to them by number in a reply. The briefing is built only from stored data, and each one is sent once.

### Replying
Reply in the briefing's thread. Replies are picked up within 5 minutes, or immediately with **Check for replies** on the dashboard.

| You write | What happens |
|---|---|
| `Add task: finish reading Friday` (also `ADD …`, `todo …`) | Task created immediately, no model call |
| `TODAY` / `TASKS` / `HELP` | Today's briefing / open tasks / the command list |
| `STOP` / `START` | Stop or resume email briefings |
| A question: "what's due this week?", "when am I free Thursday?" | Answered right away from your stored calendar, tasks and assignments |
| A change: "push my essay to Sunday", "done with 2", "make the lab high priority" | The assistant replies with a proposal. **Nothing changes until you reply `YES`** (in the same thread, within 24 hours). `NO` or `CANCEL` drops it |

How replies are handled:
- **Dates are never computed by the model.** "Sunday", "tomorrow", "11/14" and "Nov 20" are resolved by code in your timezone. "next Friday" is ambiguous, so you get a question back.
- **Canvas owns its deadlines,** so the assistant can't move a Canvas due date.
- **Your emails, event titles and Canvas text are treated as data, never as instructions,** and no change happens without your YES.
- **Each reply is handled exactly once,** even if the reply check runs again.
- **Every tool call is written to the audit log.**
- **If the model is unavailable,** the reply says so and the fixed commands keep working.

> `YES` used to mean START; now it only confirms proposals. To resume briefings after `STOP`, reply `START`.

### Checking reply quality
Every reply you send, and what the assistant did with it, is listed at **`/replies`** (linked from the dashboard and the briefing footer). Mark each one ✓ right or ✗ wrong. For a wrong one, optionally say what it should have done: answered, asked, added a task, moved a task to a date, or marked one done.

```bash
npm run eval                 # what would run + estimated cost; no API calls
npm run eval -- --oracle     # free self-check of the grader against the recorded runs
npm run eval -- --yes        # replay all marked replies through the current agent (paid)
#   options: --model claude-sonnet-5-5  --reps 2  --variant v1  --limit 20  --timeout-s 90
```
The eval replays each marked reply with the original date, timezone and lookup results, so later data changes don't affect it, and it never writes to your tasks. It grades what the assistant would **do** (the proposed changes, or none for a question) and reports:
- the overall accuracy with a 95% confidence interval;
- accuracy by intent (question / add / done / reschedule / edit / clarify);
- every failure, with the reason.

Results go to `.claude/hillclimb/email-replies/<variant>/` (per-case transcripts are git-ignored). The wording of answers is not graded.

## Worker
`npm run worker` runs these jobs with pg-boss (cron schedules stored in Postgres, schema `pgboss`):

| Job | Every | Does |
|---|---|---|
| `scheduler-tick` | minute | Heartbeat. Creates and sends each briefing now due, refreshing stale Calendar/Canvas data first. Warns hourly if Google needs reconnecting |
| `email-reply-check` | 5 min | Reads replies in recent briefing threads; retries assistant replies that died mid-run |
| `calendar-sync` | 15 min | Google Calendar sync |
| `canvas-sync` | hourly | Canvas assignment sync |

Each briefing is sent exactly once: `ScheduledBriefing` is unique per user + kind + local date, and claims are atomic. Failed sends retry after 5 and 10 minutes, then show as failed. A briefing missed while the worker was off still goes out up to 4 hours late. The dashboard's **Automation** card shows whether the worker is running.

## Development
```bash
npm test                 # unit + DB integration tests (needs TEST_DATABASE_URL; DB tests are skipped otherwise)
npm run lint && npm run typecheck && npm run build
```
- Tests never call real providers. Google, Gmail, Canvas and Claude are replaced by in-memory fakes (`tests/fake-*.ts`), and the test setup blanks `ANTHROPIC_API_KEY`.
- Coverage includes:
  - timezone/DST date handling, free-time computation and the email layout;
  - sync dedup and deletion, provider failures and retries, revoked tokens;
  - exactly-once replies and confirmations, prompt-injection attempts, model failures;
  - the eval grader.
- Schema changes: `npx prisma migrate dev --name <change>`, and commit `prisma/migrations`. Production: `npm run db:deploy`.
- If `npm run build` fails with `EINVAL … readlink` under OneDrive, delete `.next` and rebuild.

## Deployment
Any Node host works for the web app, but the worker must run continuously next to it. Today both run on a laptop.
1. Set the environment variables with `APP_URL` on the deployed HTTPS origin.
2. Run `npm run db:deploy`.
3. Add the production redirect URI in Google.
4. Run `npm run worker` as a long-lived process.

## Limitations
- Briefings and reply checks only happen while `npm run worker` is running (laptop). Free hosting is an open decision.
- Replies are picked up every 5 minutes, not instantly.
- Natural-language replies work by email only. SMS keeps the fixed commands, and SMS itself is paused.
- If the app crashes between deciding and sending, that assistant reply is lost; it is never sent twice.
- Google Calendar: primary calendar only, windowed sync (−1 to +30 days). Recurring events appear as individual instances.
- Not built, by decision: calendar month/week views, Gmail triage, Outlook, Discord, evening/weekly briefings.
