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
  kind: string; // value of the generated header, e.g. "briefing" | "reply"
  inReplyTo?: string;
};

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
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    `${GENERATED_HEADER}: ${oneLine(msg.kind)}`,
  ];
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${oneLine(msg.inReplyTo)}`, `References: ${oneLine(msg.inReplyTo)}`);
  const body = Buffer.from(msg.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
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
