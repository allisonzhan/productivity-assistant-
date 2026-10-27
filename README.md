# productivity-assistant

A student-first personal productivity web app. It imports your Google Calendar, builds daily briefings from stored data, emails them from your own Gmail, and turns replies like `Add task: finish reading Friday` into tasks. SMS (Twilio) is implemented but paused, so Gate 1 needs no paid services.

**Status:** Gate 1 (end-to-end vertical slice) is implemented and covered by automated tests. Live acceptance with a real Google account (Calendar + Gmail) is still pending; see [PROGRESS.md](PROGRESS.md). Context and rules: [CLAUDE.md](CLAUDE.md). Roadmap: [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md).

## Stack
Next.js 15 (App Router) · React 19 · TypeScript · PostgreSQL 16 · Prisma 6 · Tailwind v4 · Luxon · Zod · Vitest. Google OAuth, Calendar and Gmail over REST (no SDK); Twilio over REST (no SDK).

## Setup
```bash
docker compose up -d db        # Postgres on :5432, also creates productive_assistant_test
npm install                    # runs prisma generate
cp .env.example .env           # fill in values (see below)
npx prisma migrate dev         # apply migrations
npm run dev                    # http://localhost:3000
```
npm 11 may ask you to approve install scripts. Approve them with `npm approve-scripts @prisma/client @prisma/engines prisma esbuild unrs-resolver`.

## Environment variables
| Variable | Purpose |
|---|---|
| `APP_URL` | Browser base URL; the OAuth redirect is `${APP_URL}/api/auth/google/callback` |
| `PUBLIC_URL` | SMS only. Public HTTPS URL Twilio calls (a tunnel or deployment). Signatures are validated against it, so it must match Twilio's configuration exactly |
| `DEFAULT_TIMEZONE` | Fallback IANA zone if the Google calendar's timezone can't be read |
| `DATABASE_URL` / `TEST_DATABASE_URL` | App database and a separate test database (the tests wipe it) |
| `ENCRYPTION_KEY` | 32-byte base64 key for AES-256-GCM encryption of OAuth tokens. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth web client |
| `SMS_PROVIDER` | SMS only (paused). `twilio` (real) or `simulator` (local only, labeled SIMULATED everywhere) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | SMS only (paused). Twilio credentials and your Twilio number (E.164) |
| `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM` | Not used yet (Gate 2+) |

## Provider configuration
**Google**
1. In Google Cloud Console, create a project and enable the **Google Calendar API** and the **Gmail API**.
2. Set up the OAuth consent screen: External, Testing mode, and add your Google account as a test user.
3. Create an OAuth client of type *Web application* with the redirect URI `http://localhost:3000/api/auth/google/callback` (plus your deployed URL).
4. Scopes requested: `openid email profile calendar.readonly gmail.send gmail.readonly`. Gmail is used only to send briefings from your mailbox to yourself and to read replies in those briefing threads. You may untick Gmail at consent; the email channel then shows *Reconnect Google*. In Testing mode, refresh tokens expire after 7 days; the app then shows *Reconnect Google*.

**Twilio (paused; only needed if you switch briefings to SMS)**
1. Buy an SMS-capable number.
2. Under the number's *Messaging configuration*, set "A message comes in" to **Webhook, HTTP POST** at `${PUBLIC_URL}/api/webhooks/twilio/sms`.
3. Status callbacks are set per message (`${PUBLIC_URL}/api/webhooks/twilio/status`), so no console setup is needed.
4. US delivery requires **A2P 10DLC registration** (or toll-free verification). Trial accounts can only text verified numbers and prefix every message.
5. For local development, expose the app with `ngrok http 3000` (or `cloudflared tunnel`) and set `PUBLIC_URL` to the tunnel URL.

## Vertical-slice walkthrough (acceptance, email channel)
1. Open the app and choose **Sign in with Google & connect Calendar + Gmail**. Allow Calendar and Gmail. The first sync runs automatically.
2. The dashboard shows today's and the next seven days' events in your calendar's timezone. Hover the *Google* link to see the stored external event ID.
3. Choose **Generate & send briefing** (Briefing → Send by **Email**). The attempt shows `sent` once Gmail returns a message ID. The email arrives in your inbox from yourself.
4. Reply to that email with `Add task: finish reading Friday` as the first line.
5. Choose **Check for replies** on the Email card. The briefing attempt advances to `delivered` (Gmail shows it in your inbox), the task is created, and a reply `Added: Finish reading (due Fri …)` lands in the same thread.
6. The dashboard shows the task with a *via email* badge.
7. Duplicate checks: choose **Sync now** again (the event count does not change) and **Check for replies** again (no second task; the reply check skips the app's own mail and messages it has already handled).
8. Failure check: choose **Simulate failure** (a real Google request with an invalid token) or **Send with simulated failure** (a real Gmail request with an invalid token). A red error appears with **Retry sync** / **Retry send**.

Replies are only read from threads the app started, and only messages from your own address are acted on. Gate 1 checks replies when you click the button; a scheduled check arrives with the Gate 2 worker.

**SMS (paused):** switch Briefing → Send by **SMS** to use the Twilio path (phone verification, signed webhooks, status callbacks). With `SMS_PROVIDER=simulator` it runs against a local outbox and **does not prove live SMS**.

## Reply commands (email and SMS)
`ADD <task> [today|tomorrow|<weekday>|M/D]` (also `Add task:` and `todo`), `TODAY`, `TASKS`, `HELP`, `STOP`/`START`. Ambiguous dates such as "next friday" get a clarification reply instead of a guess. `WEEK`, `MONTH` and `DONE` are coming in Gate 2.

## Migrations
- `npx prisma migrate dev --name <change>` during development. Commit the generated `prisma/migrations`.
- `npm run db:deploy` (`prisma migrate deploy`) in production.

## Worker execution
Gate 1 has no long-running worker. Sync and briefing sends run on demand (OAuth callback and dashboard actions), and each run is recorded in `JobExecution`. Scheduled 8 AM / 7 PM briefings and periodic sync move to a durable pg-boss worker (`npm run worker`) in Gate 2.

## Tests
```bash
npm test                 # unit + DB integration tests (needs TEST_DATABASE_URL; DB tests are skipped otherwise)
npm run lint && npm run typecheck && npm run build
```
Coverage includes:
- date and time parsing across timezones and DST
- Google event normalization and all-day dates
- sync dedup, deletion, provider failure and retry, revoked tokens, bounded retries
- webhook signatures (Twilio's documented vector), duplicate webhook delivery, unknown and unverified senders
- cross-user isolation, STOP/START, ambiguity clarification, rate limiting
- briefing content, simulated and failed sends with bounded retries, out-of-order status callbacks

## Deployment
The app deploys to any Node host (Vercel, Render, Fly). Steps:
1. Set all environment variables, with `APP_URL` and `PUBLIC_URL` pointing at the deployed HTTPS origin.
2. Run `npm run db:deploy` against the production database.
3. Add the production redirect URI in Google and the production webhook URL in Twilio.

## Limitations (current)
- Sync covers the primary calendar only, with a windowed full sync (−1 to +30 days). Incremental `syncToken` sync and multiple calendars come in Gate 2.
- No scheduled briefings, quiet hours, email channel, or task/event editing UI yet (Gate 2).
- No LLM is used yet; SMS parsing is deterministic. Natural-language fallback comes in Gate 4.
- Canvas, Gmail, Outlook and Discord are not started, by design (stop gate).
