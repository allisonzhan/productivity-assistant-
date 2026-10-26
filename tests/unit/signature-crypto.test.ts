import { describe, expect, it } from "vitest";
import { computeTwilioSignature, isValidTwilioSignature } from "@/server/sms/signature";
import { decrypt, encrypt } from "@/server/crypto";

describe("Twilio signature", () => {
  // Example from Twilio's webhook security documentation.
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  };

  it("matches Twilio's documented example", () => {
    expect(computeTwilioSignature("12345", url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });

  it("rejects tampered params, wrong URL, wrong token and missing signature", () => {
    const sig = computeTwilioSignature("12345", url, params);
    expect(isValidTwilioSignature("12345", sig, url, params)).toBe(true);
    expect(isValidTwilioSignature("12345", sig, url, { ...params, Digits: "9999" })).toBe(false);
    expect(isValidTwilioSignature("12345", sig, "https://evil.example/myapp.php?foo=1&bar=2", params)).toBe(false);
    expect(isValidTwilioSignature("other", sig, url, params)).toBe(false);
    expect(isValidTwilioSignature("12345", null, url, params)).toBe(false);
  });
});

describe("credential encryption", () => {
  it("round-trips and uses a fresh IV per call", () => {
    const a = encrypt("refresh-token-123");
    const b = encrypt("refresh-token-123");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("refresh-token-123");
  });

  it("detects tampering", () => {
    const buf = Buffer.from(encrypt("secret"), "base64");
    buf[buf.length - 1] ^= 1;
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });
});
