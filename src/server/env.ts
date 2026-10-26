import "server-only";
import { z } from "zod";

const schema = z.object({
  APP_URL: z.string().url(),
  PUBLIC_URL: z.string().url().optional(),
  DEFAULT_TIMEZONE: z.string().default("America/New_York"),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  SMS_PROVIDER: z.enum(["twilio", "simulator"]).default("simulator"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated server env. Parsed lazily so `next build` works without secrets. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid or missing environment variables: ${fields}. See .env.example.`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Base URL Twilio calls; signature validation must use exactly this. */
export function publicUrl(): string {
  const e = env();
  return (e.PUBLIC_URL ?? e.APP_URL).replace(/\/$/, "");
}
