import "server-only";

import nodemailer, { type Transporter } from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import type { Attachment as MailAttachment } from "nodemailer/lib/mailer";
import { SafeError } from "@/utils/error";
import {
  forwardEmailHtml,
  forwardEmailSubject,
  forwardEmailText,
} from "@/utils/gmail/forward";
import {
  buildReplyMessageText,
  convertTextToHtmlParagraphs,
} from "@/utils/gmail/mail";
import { createReplyContent } from "@/utils/gmail/reply";
import {
  convertEmailHtmlToText,
  ensureEmailSendingEnabled,
} from "@/utils/mail";
import { formatReplySubject } from "@/utils/email/subject";
import type { MailboxConnectionSettings } from "@/utils/email/imap/connection";
import type { ParsedMessage } from "@/utils/types";

const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;
const X_MAILER = "Inbox Zero Web";

type SmtpTransport = Pick<Transporter, "sendMail"> & { close?: () => void };

export type ImapSmtpClients = {
  createTransport?: (
    options: Parameters<typeof nodemailer.createTransport>[0],
  ) => SmtpTransport;
};

export type ImapSmtpSendResult = {
  messageId: string;
  threadId: string;
};

export async function sendSmtpEmail(
  settings: MailboxConnectionSettings,
  args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
    attachments?: MailAttachment[];
  },
  clients: ImapSmtpClients = {},
): Promise<ImapSmtpSendResult> {
  return sendSmtpMessage(
    settings,
    {
      from: settings.username,
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      text: args.messageText,
      html: convertTextToHtmlParagraphs(args.messageText),
      attachments: args.attachments,
    },
    clients,
  );
}

export async function sendSmtpEmailWithHtml(
  settings: MailboxConnectionSettings,
  body: {
    replyToEmail?: {
      threadId: string;
      headerMessageId: string;
      references?: string;
      messageId?: string;
    };
    to: string;
    from?: string;
    cc?: string;
    bcc?: string;
    replyTo?: string;
    subject: string;
    messageHtml: string;
    attachments?: MailAttachment[];
  },
  clients: ImapSmtpClients = {},
): Promise<ImapSmtpSendResult> {
  const threadingHeaders = buildSmtpThreadingHeaders({
    headerMessageId: body.replyToEmail?.headerMessageId || "",
    references: body.replyToEmail?.references,
  });

  return sendSmtpMessage(
    settings,
    {
      from: body.from || settings.username,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      replyTo: body.replyTo,
      subject: body.subject,
      text: convertHtmlToText(body.messageHtml),
      html: body.messageHtml,
      attachments: body.attachments,
      ...threadingHeaders,
    },
    clients,
    body.replyToEmail?.threadId,
  );
}

export async function replyToSmtpEmail(
  settings: MailboxConnectionSettings,
  email: Pick<ParsedMessage, "threadId" | "headers" | "textPlain" | "textHtml">,
  content: string,
  options?: {
    replyTo?: string;
    from?: string;
    attachments?: MailAttachment[];
  },
  clients: ImapSmtpClients = {},
): Promise<void> {
  const { html } = createReplyContent({
    textContent: content,
    message: email,
  });
  const threadingHeaders = buildSmtpThreadingHeaders({
    headerMessageId: email.headers["message-id"] || "",
    references: email.headers.references,
  });

  await sendSmtpMessage(
    settings,
    {
      from: options?.from || settings.username,
      to: email.headers["reply-to"] || email.headers.from,
      replyTo: options?.replyTo,
      subject: formatReplySubject(email.headers.subject),
      text: buildReplyMessageText({ textContent: content, message: email }),
      html,
      attachments: options?.attachments,
      ...threadingHeaders,
    },
    clients,
    email.threadId,
  );
}

export async function forwardSmtpEmail(
  settings: MailboxConnectionSettings,
  email: ParsedMessage,
  args: {
    to: string;
    cc?: string;
    bcc?: string;
    content?: string;
    from?: string;
    attachments?: MailAttachment[];
  },
  clients: ImapSmtpClients = {},
): Promise<void> {
  if (!args.to?.trim()) {
    throw new SafeError("Recipient address is required for forwarding email.");
  }

  await sendSmtpMessage(
    settings,
    {
      from: args.from || settings.username,
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: forwardEmailSubject(email.headers.subject),
      text: forwardEmailText({ content: args.content ?? "", message: email }),
      html: forwardEmailHtml({ content: args.content ?? "", message: email }),
      attachments: args.attachments,
    },
    clients,
  );
}

async function sendSmtpMessage(
  settings: MailboxConnectionSettings,
  message: Mail.Options,
  clients: ImapSmtpClients,
  threadId?: string,
): Promise<ImapSmtpSendResult> {
  ensureEmailSendingEnabled();

  const transport = (clients.createTransport ?? createDefaultTransport)({
    host: settings.smtp.host,
    port: settings.smtp.port,
    secure: settings.smtp.secure,
    auth: {
      user: settings.username,
      pass: settings.password,
    },
    connectionTimeout: settings.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    greetingTimeout: settings.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    socketTimeout: settings.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  });

  try {
    const { bcc, ...messageHeaders } = message;
    const info = await transport.sendMail({
      ...messageHeaders,
      envelope: bcc
        ? {
            from: getEnvelopeAddresses(message.from)[0] || settings.username,
            to: getEnvelopeAddresses(message.to, message.cc, bcc),
          }
        : message.envelope,
      headers: {
        "X-Mailer": X_MAILER,
        ...message.headers,
      },
    });
    const messageId = getMessageId(info);
    return {
      messageId,
      threadId: threadId || messageId,
    };
  } catch (error) {
    throw toSafeSmtpSendError(error);
  } finally {
    try {
      transport.close?.();
    } catch {
      // ignore close errors after the send attempt has completed
    }
  }
}

function createDefaultTransport(
  options: Parameters<typeof nodemailer.createTransport>[0],
): SmtpTransport {
  return nodemailer.createTransport(options);
}

function toSafeSmtpSendError(error: unknown) {
  const code = getErrorField(error, "code");
  const command = getErrorField(error, "command");
  const responseCode = Number(getErrorField(error, "responseCode"));

  if (isAuthError(code)) {
    return new SafeError(
      "SMTP authentication failed. Check the mailbox email address and password.",
    );
  }

  if (isTimeoutError(code)) {
    return new SafeError("SMTP connection timed out. Try again in a moment.");
  }

  if (isTlsError(code)) {
    return new SafeError(
      "SMTP security check failed. Try again later or contact support.",
    );
  }

  if (isRecipientError(responseCode, command)) {
    return new SafeError(
      "SMTP rejected one or more recipients. Check the recipient addresses and try again.",
    );
  }

  if (responseCode === 552) {
    return new SafeError("SMTP rejected the message because it is too large.");
  }

  if (isConnectionError(code)) {
    return new SafeError("SMTP server could not be reached. Try again later.");
  }

  return new SafeError("Email could not be sent. Try again later.");
}

function isAuthError(code: string | undefined) {
  return code === "EAUTH" || code === "AUTHENTICATIONFAILED";
}

function isTimeoutError(code: string | undefined) {
  return (
    code === "ETIMEDOUT" || code === "ETIMEOUT" || code === "ESOCKETTIMEDOUT"
  );
}

function isTlsError(code: string | undefined) {
  return (
    code?.startsWith("ERR_TLS") === true ||
    code?.includes("CERT") === true ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  );
}

function isRecipientError(responseCode: number, command: string | undefined) {
  return (
    command === "RCPT TO" ||
    responseCode === 550 ||
    responseCode === 551 ||
    responseCode === 553
  );
}

function isConnectionError(code: string | undefined) {
  return (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ECONNRESET"
  );
}

function getMessageId(info: unknown) {
  if (typeof info !== "object" || info === null || !("messageId" in info)) {
    return "";
  }

  return String((info as { messageId?: unknown }).messageId || "");
}

function getErrorField(error: unknown, field: string) {
  if (typeof error !== "object" || error === null || !(field in error)) {
    return;
  }

  return String((error as Record<string, unknown>)[field]);
}

function convertHtmlToText(html: string) {
  try {
    return convertEmailHtmlToText({ htmlText: html });
  } catch {
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .trim();
  }
}

type MailAddressValue = Mail.Options["to"] | Mail.Options["from"];

function getEnvelopeAddresses(...values: MailAddressValue[]) {
  return values.flatMap(getEnvelopeAddressesFromValue).filter(Boolean);
}

function getEnvelopeAddressesFromValue(value: MailAddressValue): string[] {
  if (!value) return [];
  if (typeof value === "string") {
    return splitAddressList(value).map(extractEmailAddress).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap(getEnvelopeAddressesFromValue);
  }
  if (typeof value === "object" && "address" in value) {
    return [String(value.address || "")].filter(Boolean);
  }
  return [];
}

function splitAddressList(value: string) {
  return value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((item) => item.trim());
}

function extractEmailAddress(value: string) {
  const match = value.match(/<([^<>]+)>/);
  return (match?.[1] || value).replace(/^"|"$/g, "").trim();
}

function buildSmtpThreadingHeaders(options: {
  headerMessageId: string;
  references?: string;
}): Pick<Mail.Options, "inReplyTo" | "references"> {
  if (!options.headerMessageId) return {};

  const parentMessageId = formatMessageId(options.headerMessageId);
  const references = [
    ...parseReferenceIds(options.references || ""),
    parentMessageId,
  ];

  return {
    inReplyTo: parentMessageId,
    references: references.join(" "),
  };
}

function parseReferenceIds(references: string) {
  return references
    .split(/\s+/)
    .map((reference) => reference.trim())
    .filter(Boolean)
    .map(formatMessageId);
}

function formatMessageId(messageId: string) {
  const trimmed = messageId.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed
    : `<${trimmed.replace(/^<|>$/g, "")}>`;
}
