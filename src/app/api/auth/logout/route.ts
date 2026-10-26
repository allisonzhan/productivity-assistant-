import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, destroySession } from "@/server/auth/session";
import { env } from "@/server/env";

export async function POST(req: NextRequest) {
  await destroySession(req.cookies.get(SESSION_COOKIE)?.value);
  const res = NextResponse.redirect(new URL("/", env().APP_URL), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
