import { describe, expect, it } from "vitest";
import { buildMime, extractReplyCommand, parseAddress, payloadText, replySubject } from "@/server/email/mime";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("email MIME helpers", () => {
  it("builds a plain-text message with an encoded subject and the generated marker", () => {
    const mime = buildMime({ from: "me@x.test", to: "me@x.test", subject: "Your briefing for Mon Oct 26", body: "TODAY: 9:00am Lecture\nBye", kind: "briefing", inReplyTo: "<abc@mail.gmail.com>" });
    const [head, body] = mime.split("\r\n\r\n");
    expect(head).toContain("To: me@x.test");
    expect(head).toContain("X-PA-Generated: briefing");
    expect(head).toContain("In-Reply-To: <abc@mail.gmail.com>");
    const subject = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(head)![1];
    expect(Buffer.from(subject, "base64").toString("utf8")).toBe("Your briefing for Mon Oct 26");
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("TODAY: 9:00am Lecture\r\nBye");
  });

  it("strips line breaks from header values (no header injection)", () => {
    const mime = buildMime({ from: "me@x.test", to: "me@x.test\r\nBcc: evil@x.test", subject: "s", body: "b", kind: "reply" });
    expect(mime.split("\r\n\r\n")[0]).not.toMatch(/^Bcc:/m);
  });

  it("parses addresses and reply subjects", () => {
    expect(parseAddress('"Allison L" <Me@X.test>')).toBe("me@x.test");
    expect(parseAddress("me@x.test")).toBe("me@x.test");
    expect(parseAddress(undefined)).toBeNull();
    expect(replySubject("Your briefing")).toBe("Re: Your briefing");
    expect(replySubject("RE: Your briefing")).toBe("RE: Your briefing");
  });

  it("prefers the text/plain part and falls back to stripped HTML", () => {
    const multipart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("Add task: essay Friday") } },
        { mimeType: "text/html", body: { data: b64("<div>ignored</div>") } },
      ],
    };
    expect(payloadText(multipart)).toBe("Add task: essay Friday");
    const htmlOnly = { mimeType: "text/html", body: { data: b64("<div>TASKS</div><blockquote>old briefing</blockquote>") } };
    expect(extractReplyCommand(payloadText(htmlOnly))).toBe("TASKS");
  });

  it("takes the first line written above the quoted briefing", () => {
    const gmailReply = [
      "Add task: finish reading Friday",
      "",
      "On Mon, Oct 26, 2026 at 9:00 AM Allison <",
      "me@x.test> wrote:",
      "> Mon Oct 26 briefing",
      "> Reply ADD <task>, TODAY, HELP",
    ].join("\r\n");
    expect(extractReplyCommand(gmailReply)).toBe("Add task: finish reading Friday");
    expect(extractReplyCommand("\n\n  TODAY  \n-- \nAllison")).toBe("TODAY");
    expect(extractReplyCommand("Sent from my iPhone\n> quoted")).toBe("");
    expect(extractReplyCommand("> only quoted text")).toBe("");
  });
});
