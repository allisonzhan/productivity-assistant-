import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "@/server/env";
import { decrypt, encrypt, randomToken } from "@/server/crypto";

// Least privilege: identity + read-only calendar. Calendar writes come later with confirmation.
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export const OAUTH_COOKIE = "pa_oauth";
const OAUTH_TTL_MS = 10 * 60 * 1000;

export function redirectUri(): string {
  return `${env().APP_URL.replace(/\/$/, "")}/api/auth/google/callback`;
}

/** Builds the consent URL plus an encrypted cookie holding state + PKCE verifier. */
export function buildAuthorizationRequest(): { url: string; cookieValue: string } {
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: env().GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // guarantees a refresh token on reconnect
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const cookieValue = encrypt(JSON.stringify({ state, verifier, createdAt: Date.now() }));
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, cookieValue };
}

export function readOAuthCookie(cookieValue: string | undefined, state: string | null): { verifier: string } {
  if (!cookieValue || !state) throw new Error("Missing OAuth state");
  const parsed = z
    .object({ state: z.string(), verifier: z.string(), createdAt: z.number() })
    .parse(JSON.parse(decrypt(cookieValue)));
  if (parsed.state !== state) throw new Error("OAuth state mismatch");
  if (Date.now() - parsed.createdAt > OAUTH_TTL_MS) throw new Error("OAuth request expired; try again");
  return { verifier: parsed.verifier };
}

const tokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string(),
  id_token: z.string().optional(),
  token_type: z.string(),
});
export type GoogleTokenResponse = z.infer<typeof tokenResponse>;

export class GoogleOAuthError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function tokenRequest(body: Record<string, string>, fetchImpl: typeof fetch): Promise<GoogleTokenResponse> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
    throw new GoogleOAuthError(`Google token endpoint error: ${code} ${json.error_description ?? ""}`.trim(), code);
  }
  return tokenResponse.parse(json);
}

export function exchangeCode(code: string, verifier: string, fetchImpl: typeof fetch = fetch) {
  return tokenRequest(
    {
      code,
      code_verifier: verifier,
      client_id: env().GOOGLE_CLIENT_ID,
      client_secret: env().GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    },
    fetchImpl,
  );
}

export function refreshAccessToken(refreshToken: string, fetchImpl: typeof fetch = fetch) {
  return tokenRequest(
    {
      refresh_token: refreshToken,
      client_id: env().GOOGLE_CLIENT_ID,
      client_secret: env().GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    },
    fetchImpl,
  );
}

const idTokenClaims = z.object({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.string(),
  sub: z.string(),
  email: z.string().email(),
  email_verified: z.boolean(),
  name: z.string().optional(),
  exp: z.number(),
});

/**
 * The ID token came straight from Google's token endpoint over TLS (authenticated with our
 * client secret), so per OIDC Core §3.1.3.7 we validate the claims without fetching JWKS.
 */
export function parseIdToken(idToken: string) {
  const payload = idToken.split(".")[1];
  if (!payload) throw new GoogleOAuthError("Malformed ID token");
  const claims = idTokenClaims.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  if (claims.aud !== env().GOOGLE_CLIENT_ID) throw new GoogleOAuthError("ID token audience mismatch");
  if (claims.exp * 1000 < Date.now()) throw new GoogleOAuthError("ID token expired");
  if (!claims.email_verified) throw new GoogleOAuthError("Google email is not verified");
  return claims;
}
