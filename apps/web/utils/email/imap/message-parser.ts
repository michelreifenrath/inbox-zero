import { simpleParser, type ParsedMail } from "mailparser";
import type { ParsedMessage, ParsedMessageHeaders } from "@/utils/types";

export type ImapMessageSource = {
  id: string;
  mailbox: string;
  uid: number;
  source: Buffer | string;
  flags?: Set<string>;
  internalDate?: Date | string;
  size?: number;
};

export async function parseImapMessage(
  message: ImapMessageSource,
): Promise<ParsedMessage> {
  const parsed = await simpleParser(message.source);
  const headers = getHeaders(parsed);
  const messageId = headers["message-id"];
  const threadId = getThreadIdFromHeaders(headers) || messageId || message.id;
  const textHtml = typeof parsed.html === "string" ? parsed.html : undefined;
  const textPlain = parsed.text || undefined;
  const date = formatDate(
    parsed.date || headers.date || message.internalDate || new Date(0),
  );

  return {
    id: message.id,
    threadId,
    historyId: String(message.uid),
    date,
    internalDate: message.internalDate
      ? new Date(message.internalDate).getTime().toString()
      : undefined,
    labelIds: getLabelIds(message.mailbox, message.flags),
    parentFolderId: message.mailbox,
    subject: parsed.subject || headers.subject || "",
    snippet: getSnippet(textPlain, textHtml),
    textHtml,
    textPlain,
    bodyContentType: textHtml ? "html" : "text",
    headers,
    attachments: parsed.attachments
      .filter((attachment) => !isInlineAttachment(attachment))
      .map((attachment, index) => ({
        attachmentId: getAttachmentId(index),
        filename: attachment.filename || "attachment",
        mimeType: attachment.contentType || "application/octet-stream",
        size: attachment.size || attachment.content.length,
        headers: {
          "content-description": getHeaderValue(
            attachment.headers,
            "content-description",
          ),
          "content-id": stripAngleBrackets(
            attachment.contentId ||
              getHeaderValue(attachment.headers, "content-id"),
          ),
          "content-transfer-encoding": getHeaderValue(
            attachment.headers,
            "content-transfer-encoding",
          ),
          "content-type": attachment.contentType || "application/octet-stream",
        },
      })),
    inline: parsed.attachments
      .filter(isInlineAttachment)
      .map((attachment, index) => ({
        attachmentId: getAttachmentId(index),
        filename: attachment.filename || "inline-attachment",
        mimeType: attachment.contentType || "application/octet-stream",
        size: attachment.size || attachment.content.length,
        headers: {
          "content-description": getHeaderValue(
            attachment.headers,
            "content-description",
          ),
          "content-id": stripAngleBrackets(
            attachment.contentId ||
              getHeaderValue(attachment.headers, "content-id"),
          ),
          "content-transfer-encoding": getHeaderValue(
            attachment.headers,
            "content-transfer-encoding",
          ),
          "content-type": attachment.contentType || "application/octet-stream",
        },
      })),
  };
}

export async function parseImapAttachment(
  source: Buffer | string,
  attachmentId: string,
): Promise<{ data: string; size: number }> {
  const parsed = await simpleParser(source);
  const attachmentIndex = getAttachmentIndex(attachmentId);
  const attachment = parsed.attachments.filter(
    (item) => !isInlineAttachment(item),
  )[attachmentIndex];

  if (!attachment) {
    throw new Error(`IMAP attachment not found: ${attachmentId}`);
  }

  return {
    data: attachment.content.toString("base64"),
    size: attachment.size || attachment.content.length,
  };
}

export function getThreadIdFromHeaders(
  headers: Pick<
    ParsedMessageHeaders,
    "references" | "in-reply-to" | "message-id"
  >,
) {
  const referenceIds = parseMessageIds(headers.references || "");
  if (referenceIds[0]) return referenceIds[0];

  const inReplyToIds = parseMessageIds(headers["in-reply-to"] || "");
  if (inReplyToIds[0]) return inReplyToIds[0];

  return headers["message-id"] || "";
}

export function parseMessageIds(value: string) {
  const bracketedIds = Array.from(value.matchAll(/<[^<>]+>/g), (match) =>
    normalizeMessageId(match[0]),
  ).filter(Boolean);

  if (bracketedIds.length) return bracketedIds;

  return value.split(/\s+/).map(normalizeMessageId).filter(Boolean);
}

export function normalizeMessageId(value: string | undefined) {
  return stripAngleBrackets(value || "")
    .trim()
    .toLowerCase();
}

function getHeaders(parsed: ParsedMail): ParsedMessageHeaders {
  return {
    bcc: getAddressHeader(parsed, "bcc"),
    cc: getAddressHeader(parsed, "cc"),
    date: formatDate(
      parsed.date || getParsedHeaderValue(parsed, "date") || new Date(0),
    ),
    from: getAddressHeader(parsed, "from"),
    "in-reply-to": normalizeMessageId(
      getParsedHeaderValue(parsed, "in-reply-to"),
    ),
    "list-unsubscribe": getRawHeaderValue(parsed, "list-unsubscribe"),
    "message-id": normalizeMessageId(
      getParsedHeaderValue(parsed, "message-id"),
    ),
    references: parseMessageIds(
      getParsedHeaderValue(parsed, "references"),
    ).join(" "),
    "reply-to": getAddressHeader(parsed, "reply-to"),
    subject: parsed.subject || getParsedHeaderValue(parsed, "subject"),
    to: getAddressHeader(parsed, "to"),
  };
}

function getAddressHeader(
  parsed: ParsedMail,
  key: "from" | "to" | "cc" | "bcc" | "reply-to",
) {
  const value = key === "reply-to" ? parsed.replyTo : parsed[key];
  if (value?.value?.length) {
    return value.value
      .map((address) =>
        address.name
          ? `${address.name} <${address.address || ""}>`
          : address.address || "",
      )
      .filter(Boolean)
      .join(", ");
  }
  return getParsedHeaderValue(parsed, key);
}

function getParsedHeaderValue(parsed: ParsedMail, key: string) {
  return getHeaderValue(parsed.headers, key) || getRawHeaderValue(parsed, key);
}

function getRawHeaderValue(parsed: ParsedMail, key: string) {
  const headerLine = parsed.headerLines.find(
    (line) => line.key.toLowerCase() === key.toLowerCase(),
  );
  if (!headerLine) return "";
  return headerLine.line.slice(headerLine.line.indexOf(":") + 1).trim();
}

function getHeaderValue(headers: Map<string, unknown>, key: string) {
  const value = headers.get(key.toLowerCase());
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.join(" ");
  if (typeof value === "object" && "text" in value) {
    return String((value as { text?: string }).text || "");
  }
  return String(value);
}

function getLabelIds(mailbox: string, flags: Set<string> | undefined) {
  const labelIds = [mailbox];
  if (flags?.has("\\Seen") === false) labelIds.push("UNREAD");
  if (flags?.has("\\Flagged")) labelIds.push("STARRED");
  return labelIds;
}

function getSnippet(
  textPlain: string | undefined,
  textHtml: string | undefined,
) {
  const source =
    textPlain || (textHtml ? textHtml.replace(/<[^>]*>/g, " ") : "");
  return source.replace(/\s+/g, " ").trim().slice(0, 200);
}

function isInlineAttachment(attachment: ParsedMail["attachments"][number]) {
  return attachment.contentDisposition === "inline";
}

function getAttachmentId(index: number) {
  return `imap-attachment-${index}`;
}

function getAttachmentIndex(attachmentId: string) {
  const match = attachmentId.match(/^(?:imap-attachment-)?(\d+)$/);
  if (!match) return -1;
  return Number(match[1]);
}

function stripAngleBrackets(value: string) {
  return value.replace(/^<|>$/g, "");
}

function formatDate(value: Date | string) {
  return new Date(value).toISOString();
}
