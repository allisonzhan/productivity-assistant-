/**
 * Pure helpers for the email channel: building outgoing plain-text messages and pulling the
 * user's command out of a reply. Reply text is untrusted data; it only feeds the
 * deterministic command parser.
 */

// Every message the app sends carries this header, so the reply check never treats the app's
// own mail as a user command (even if recording the send failed after Gmail accepted it).
export const GENERATED_HEADER = "X-PA-Generated";

export type OutgoingEmail = {
  from: string;
  to: string;
  subject: string;
  body: string;
  /** Optional HTML alternative; the plain-text `body` is always sent too. */
  html?: string;
  kind: string; // value of the generated header, e.g. "briefing" | "reply"
  inReplyTo?: string;
};

function base64Body(text: string): string {
  return Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(oneLine(value), "utf8").toString("base64")}?=`;
}

/** RFC 5322 message as a string. Header values are stripped of line breaks (no header injection). */
export function buildMime(msg: OutgoingEmail): string {
  const headers = [
    `From: ${oneLine(msg.from)}`,
    `To: ${oneLine(msg.to)}`,
    `Subject: ${encodeWord(msg.subject)}`,
    "MIME-Version: 1.0",
    `${GENERATED_HEADER}: ${oneLine(msg.kind)}`,
  ];
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${oneLine(msg.inReplyTo)}`, `References: ${oneLine(msg.inReplyTo)}`);
  if (msg.html === undefined) {
    headers.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
    return `${headers.join("\r\n")}\r\n\r\n${base64Body(msg.body)}`;
  }
  const boundary = `pa_${Buffer.from(msg.subject + msg.body.length).toString("hex").slice(0, 16)}_${Date.now().toString(36)}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type: string, text: string) =>
    `--${boundary}\r\nContent-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Body(text)}\r\n`;
  return `${headers.join("\r\n")}\r\n\r\n${part("text/plain", msg.body)}${part("text/html", msg.html)}--${boundary}--\r\n`;
}

export function replySubject(subject: string): string {
  const s = oneLine(subject);
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** "Name <a@b.com>" or "a@b.com" -> "a@b.com" (lowercased); null if no address. */
export function parseAddress(header: string | undefined): string | null {
  if (!header) return null;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(header);
  const bare = angle ? angle[1] : /([^\s<>,;"]+@[^\s<>,;"]+)/.exec(header)?.[1];
  return bare ? bare.toLowerCase() : null;
}

type Part = { mimeType?: string; filename?: string; body?: { data?: string }; parts?: Part[] };

/** The text of a Gmail message payload: the first text/plain part, else text/html stripped of tags. */
export function payloadText(payload: Part | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return plain;
  const html = findPart(payload, "text/html");
  return html ? htmlToText(html) : "";
}

function findPart(part: Part | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && !part.filename && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n>\n") // quoted history
    .replace(/<(br|\/p|\/div)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const QUOTE_START = [
  /^>/, // quoted line
  /^-{2,}\s*Original Message/i,
  /^_{5,}$/, // Outlook separator
  /^From:\s/i, // Outlook header block
  /^--\s?$/, // signature delimiter
  /^Sent from my /i,
];

/**
 * Everything the user wrote above the quoted history (trimmed, capped). The command parser
 * still reads only its first line; the agent gets all of it.
 */
export function extractReplyText(text: string, maxChars = 1000): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (QUOTE_START.some((re) => re.test(line))) break;
    if (/^On\s/.test(line) && (/wrote:$/.test(line) || /wrote:$/.test(lines[i + 1] ?? ""))) break;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
}

/**
 * The command in a reply: the first non-empty line written above the quoted history.
 * Taking one line keeps signatures and quoted briefings out of task titles.
 */
export function extractReplyCommand(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (QUOTE_START.some((re) => re.test(line))) break;
    // "On Mon, Oct 26, 2026 at 9:00 AM Name <a@b.com> wrote:" (Gmail may wrap it onto two lines)
    if (/^On\s/.test(line) && (/wrote:$/.test(line) || /wrote:$/.test(lines[i + 1] ?? ""))) break;
    if (line) return line;
  }
  return "";
}
