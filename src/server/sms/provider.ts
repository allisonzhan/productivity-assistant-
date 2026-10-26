import { randomToken } from "@/server/crypto";

export type SmsProviderName = "twilio" | "simulator";

export class SmsSendError extends Error {
  constructor(message: string, readonly providerCode?: string) {
    super(message);
  }
}

export type SendResult = { providerMessageId: string; providerStatus: string };

export interface SmsProvider {
  name: SmsProviderName;
  send(msg: { to: string; body: string; statusCallback?: string; simulateFailure?: boolean }): Promise<SendResult>;
}

export function twilioProvider(cfg: {
  accountSid: string;
  authToken: string;
  from: string;
  fetchImpl?: typeof fetch;
}): SmsProvider {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  return {
    name: "twilio",
    async send({ to, body, statusCallback, simulateFailure }) {
      const form = new URLSearchParams({
        To: to,
        // Simulated failure: a real Twilio request with an invalid sender, which Twilio rejects.
        From: simulateFailure ? "+10000000000" : cfg.from,
        Body: body,
      });
      if (statusCallback) form.set("StatusCallback", statusCallback);
      let res: Response;
      try {
        res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form,
        });
      } catch (err) {
        throw new SmsSendError(`Network error calling Twilio: ${(err as Error).message}`);
      }
      const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; code?: number; message?: string };
      if (!res.ok || !json.sid) {
        throw new SmsSendError(`Twilio ${res.status}: ${json.message ?? "unknown error"}`, json.code?.toString());
      }
      return { providerMessageId: json.sid, providerStatus: json.status ?? "queued" };
    },
  };
}

/** Local development only. Nothing leaves this machine; the UI labels these SIMULATED. */
export function simulatorProvider(): SmsProvider {
  return {
    name: "simulator",
    async send({ simulateFailure }) {
      if (simulateFailure) throw new SmsSendError("[Simulator] Simulated provider failure");
      return { providerMessageId: `SIM${randomToken(16)}`, providerStatus: "simulated" };
    },
  };
}
