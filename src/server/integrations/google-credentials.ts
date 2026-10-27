import { prisma } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";
import { GoogleOAuthError, refreshAccessToken, type GoogleTokenResponse } from "@/server/auth/google-oauth";

export const GOOGLE_CALENDAR = "google_calendar";
// Health of the email reply check. It has no credential of its own: Gmail uses the Google tokens.
export const GMAIL = "gmail";

export class ReauthRequiredError extends Error {
  constructor(message = "Google access was revoked or expired. Reconnect Google Calendar.") {
    super(message);
  }
}

/** Creates or updates the Google Calendar integration with freshly granted tokens. */
export async function saveGoogleTokens(userId: string, tokens: GoogleTokenResponse) {
  const integration = await prisma.integration.upsert({
    where: { userId_provider: { userId, provider: GOOGLE_CALENDAR } },
    create: { userId, provider: GOOGLE_CALENDAR, status: "connected" },
    update: { status: "connected", lastError: null, lastErrorAt: null },
  });
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await prisma.integrationCredential.upsert({
    where: { integrationId: integration.id },
    create: {
      integrationId: integration.id,
      accessTokenEnc: encrypt(tokens.access_token),
      refreshTokenEnc: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      expiresAt,
      scope: tokens.scope,
    },
    update: {
      accessTokenEnc: encrypt(tokens.access_token),
      // Google omits refresh_token on some re-consents; keep the stored one then.
      ...(tokens.refresh_token ? { refreshTokenEnc: encrypt(tokens.refresh_token) } : {}),
      expiresAt,
      scope: tokens.scope,
    },
  });
  return integration;
}

/** Whether the stored Google grant includes `scope` (Google's consent screen lets users untick scopes). */
export async function hasGoogleScope(userId: string, scope: string): Promise<boolean> {
  const integration = await prisma.integration.findUnique({
    where: { userId_provider: { userId, provider: GOOGLE_CALENDAR } },
    include: { credential: { select: { scope: true } } },
  });
  return !!integration?.credential?.scope.split(" ").includes(scope);
}

/** Access token for a Gmail call; requires that the user granted `scope`. */
export async function getGmailAccessToken(userId: string, scope: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const integration = await prisma.integration.findUnique({
    where: { userId_provider: { userId, provider: GOOGLE_CALENDAR } },
    include: { credential: { select: { scope: true } } },
  });
  if (!integration?.credential) throw new ReauthRequiredError("Google is not connected. Sign in with Google again.");
  if (!integration.credential.scope.split(" ").includes(scope)) {
    throw new ReauthRequiredError("Gmail access was not granted. Reconnect Google and allow Gmail access.");
  }
  return getGoogleAccessToken(integration.id, fetchImpl);
}

/** Returns a usable access token, refreshing it if it expires within 60s. */
export async function getGoogleAccessToken(integrationId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const cred = await prisma.integrationCredential.findUnique({ where: { integrationId } });
  if (!cred) throw new ReauthRequiredError("No stored Google credentials. Connect Google Calendar.");
  if (cred.expiresAt && cred.expiresAt.getTime() - Date.now() > 60_000) return decrypt(cred.accessTokenEnc);
  if (!cred.refreshTokenEnc) throw new ReauthRequiredError();

  try {
    const tokens = await refreshAccessToken(decrypt(cred.refreshTokenEnc), fetchImpl);
    await prisma.integrationCredential.update({
      where: { integrationId },
      data: {
        accessTokenEnc: encrypt(tokens.access_token),
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        ...(tokens.refresh_token ? { refreshTokenEnc: encrypt(tokens.refresh_token) } : {}),
      },
    });
    return tokens.access_token;
  } catch (err) {
    if (err instanceof GoogleOAuthError && err.code === "invalid_grant") throw new ReauthRequiredError();
    throw err;
  }
}
