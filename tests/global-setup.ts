import { execSync } from "node:child_process";

/** Applies migrations to the test database once per run (if one is configured). */
export default function setup() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // optional
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.warn("TEST_DATABASE_URL not set: database integration tests will be skipped.");
    return;
  }
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
}
