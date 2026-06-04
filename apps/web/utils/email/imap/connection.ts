import "server-only";

import { ImapFlow, type ImapFlowOptions } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import { SafeError } from "@/utils/error";

const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;

export type MailboxConnectionSettings = {
  imap: {
    host: string;
    port: number;
    secure: boolean;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
  };
  username: string;
  password: string;
  timeoutMs?: number;
};

type ImapClient = {
  connect(): Promise<void>;
  close(): void;
};

type SmtpClient = Pick<Transporter, "verify" | "close">;

export type MailboxConnectionClients = {
  createImapClient?: (options: ImapFlowOptions) => ImapClient;
  createSmtpClient?: (
    options: Parameters<typeof nodemailer.createTransport>[0],
  ) => SmtpClient;
};

export async function verifyMailboxConnection(
  settings: MailboxConnectionSettings,
  clients: MailboxConnectionClients = {},
) {
  await verifyImapConnection(settings, clients.createImapClient);
  await verifySmtpConnection(settings, clients.createSmtpClient);
}

async function verifyImapConnection(
  settings: MailboxConnectionSettings,
  createImapClient: MailboxConnectionClients["createImapClient"],
) {
  const client = (createImapClient ?? createDefaultImapClient)({
    host: settings.imap.host,
    port: settings.imap.port,
    secure: settings.imap.secure,
    auth: {
      user: settings.username,
      pass: settings.password,
    },
    logger: false,
    verifyOnly: true,
    connectionTimeout: settings.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    greetingTimeout: settings.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    socketTimeout: settings.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  });

  try {
    await client.connect();
  } catch (error) {
    throw toSafeConnectionError("IMAP", error);
  } finally {
    closeImapClient(client);
  }
}

async function verifySmtpConnection(
  settings: MailboxConnectionSettings,
  createSmtpClient: MailboxConnectionClients["createSmtpClient"],
) {
  const client = (createSmtpClient ?? createDefaultSmtpClient)({
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
    await client.verify();
  } catch (error) {
    throw toSafeConnectionError("SMTP", error);
  } finally {
    client.close();
  }
}

function createDefaultImapClient(options: ImapFlowOptions): ImapClient {
  return new ImapFlow(options);
}

function createDefaultSmtpClient(
  options: Parameters<typeof nodemailer.createTransport>[0],
): SmtpClient {
  return nodemailer.createTransport(options);
}

function closeImapClient(client: ImapClient) {
  try {
    client.close();
  } catch {
    return;
  }
}

function toSafeConnectionError(service: "IMAP" | "SMTP", error: unknown) {
  const code = getErrorField(error, "code");

  if (isAuthError(error, code)) {
    return new SafeError(
      `${service} authentication failed. Check the mailbox email address and password.`,
    );
  }

  if (isTimeoutError(error, code)) {
    return new SafeError(
      `${service} connection timed out. Try again in a moment.`,
    );
  }

  if (isTlsError(error, code)) {
    return new SafeError(
      `${service} security check failed. Try again later or contact support.`,
    );
  }

  if (isDnsError(code)) {
    return new SafeError(
      `${service} server could not be reached. Try again later.`,
    );
  }

  return new SafeError(
    `${service} connection could not be verified. Try again later.`,
  );
}

function isAuthError(error: unknown, code: string | undefined) {
  return (
    code === "EAUTH" ||
    code === "AUTHENTICATIONFAILED" ||
    getErrorField(error, "authenticationFailed") === "true"
  );
}

function isTimeoutError(error: unknown, code: string | undefined) {
  return (
    code === "ETIMEDOUT" ||
    code === "ETIMEOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    getErrorField(error, "timeout") === "true"
  );
}

function isTlsError(error: unknown, code: string | undefined) {
  return (
    code?.startsWith("ERR_TLS") === true ||
    code?.includes("CERT") === true ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    getErrorField(error, "tlsFailed") === "true"
  );
}

function isDnsError(code: string | undefined) {
  return (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ECONNRESET"
  );
}

function getErrorField(error: unknown, field: string) {
  if (typeof error !== "object" || error === null || !(field in error)) {
    return;
  }

  return String((error as Record<string, unknown>)[field]);
}
