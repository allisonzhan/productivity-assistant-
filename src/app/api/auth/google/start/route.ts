import { NextResponse } from "next/server";
import { OAUTH_COOKIE, buildAuthorizationRequest } from "@/server/auth/google-oauth";

export async function GET() {
  const { url, cookieValue } = buildAuthorizationRequest();
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/google",
    maxAge: 600,
  });
  return res;
}
