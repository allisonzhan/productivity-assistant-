import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { OAUTH_COOKIE, exchangeCode, parseIdToken, readOAuthCookie } from "@/server/auth/google-oauth";
import { SESSION_COOKIE, createSession, sessionCookieOptions } from "@/server/auth/session";
import { getCalendarTimezone } from "@/server/calendar/google-client";
import { saveGoogleTokens } from "@/server/integrations/google-credentials";
import { syncGoogleCalendar } from "@/server/sync/google-calendar-sync";
import { audit } from "@/server/audit/log";
import { errorMessage } from "@/server/jobs/run";
import { isValidZone } from "@/server/time";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export async function GET(req: NextRequest) {
  const appUrl = env().APP_URL;
  const fail = (message: string) => {
    const res = NextResponse.redirect(new URL(`/?error=${encodeURIComponent(message)}`, appUrl));
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth/google" });
    return res;
  };

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail(`Google sign-in was cancelled (${params.get("error")}).`);
  const code = params.get("code");
  if (!code) return fail("Missing authorization code.");

  try {
    const { verifier } = readOAuthCookie(req.cookies.get(OAUTH_COOKIE)?.value, params.get("state"));
    const tokens = await exchangeCode(code, verifier);
    if (!tokens.id_token) return fail("Google did not return an ID token.");
    if (!tokens.scope.split(" ").includes(CALENDAR_SCOPE)) {
      return fail("Calendar access was not granted. Connect again and allow calendar access.");
    }
    const claims = parseIdToken(tokens.id_token);

    const calendarZone = await getCalendarTimezone(tokens.access_token);
    const timezone = calendarZone && isValidZone(calendarZone) ? calendarZone : env().DEFAULT_TIMEZONE;
    const user = await prisma.user.upsert({
      where: { googleSubject: claims.sub },
      create: { googleSubject: claims.sub, email: claims.email, name: claims.name, timezone },
      update: { email: claims.email, name: claims.name },
    });
    await saveGoogleTokens(user.id, tokens);
    await audit({ userId: user.id, actor: "user", action: "integration.connect", entityType: "Integration", metadata: { provider: "google_calendar" } });

    // First import right away; failures are recorded on the integration and shown on the dashboard.
    await syncGoogleCalendar(user.id);

    const session = await createSession(user.id);
    const res = NextResponse.redirect(new URL("/", appUrl));
    res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth/google" });
    return res;
  } catch (err) {
    console.error("OAuth callback failed", err);
    return fail(`Google sign-in failed: ${errorMessage(err)}`);
  }
}
