import { randomBytes } from "node:crypto";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env: DB tests are skipped unless TEST_DATABASE_URL is set in the environment.
}

// Tests never touch the development database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://invalid/skip";
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "http://localhost:3000";
process.env.PUBLIC_URL = "https://pa.example.test";
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.SMS_PROVIDER = "simulator";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
process.env.TWILIO_FROM_NUMBER = "+15555550100";
