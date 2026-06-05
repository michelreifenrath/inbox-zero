import "server-only";

import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type { ParsedMessage } from "@/utils/types";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { getImapConnectionSettingsForEmail } from "@/utils/email-account-client";
import { ImapProvider } from "@/utils/email/imap/provider";
import { parseImapMessage } from "@/utils/email/imap/message-parser";
import { isImapProvider } from "@/utils/email/provider-types";
import {
  getUserTier,
  hasAiAccess,
  premiumEntitlementSelect,
} from "@/utils/premium";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";

const DEFAULT_MAILBOX = "INBOX";
const DEFAULT_MAX_MESSAGES = 100;

export type ImapSyncCursor = {
  mailboxes?: Record<
    string,
    {
      uidValidity: string;
      lastUid: number;
      syncedAt: string;
    }
  >;
};

export type ImapMailboxSyncClient = {
  connect(): Promise<void>;
  close(): void;
  logout?(): Promise<void>;
  status?(
    path: string,
    query: { messages?: boolean; uidNext?: boolean; uidValidity?: boolean },
  ): Promise<{ uidValidity?: number | string | bigint }>;
  mailboxOpen?(
    path: string,
    options?: { readOnly?: boolean },
  ): Promise<{ uidValidity?: number | string | bigint } | unknown>;
  mailboxClose?(): Promise<unknown>;
  getMailboxLock?(
    path: string,
    options?: { readOnly?: boolean },
  ): Promise<{ release(): void }>;
  search(query: { all: true }, options?: { uid?: boolean }): Promise<number[]>;
  fetch(
    range: number[] | string,
    query: {
      uid?: boolean;
      flags?: boolean;
      internalDate?: boolean;
      size?: boolean;
      source?: boolean;
    },
    options?: { uid?: boolean },
  ): AsyncIterable<{
    uid: number;
    flags?: Set<string>;
    internalDate?: Date | string;
    size?: number;
    source?: Buffer;
  }>;
};

export type ImapSyncResult = {
  emailAccountId: string;
  mailbox: string;
  processed: number;
  lastUid: number;
  uidValidity: string;
  uidValidityChanged: boolean;
};

export async function syncImapAccount({
  emailAccountId,
  logger,
  mailbox = DEFAULT_MAILBOX,
  maxMessages = DEFAULT_MAX_MESSAGES,
  createClient = createDefaultClient,
}: {
  emailAccountId: string;
  logger: Logger;
  mailbox?: string;
  maxMessages?: number;
  createClient?: (options: ImapFlowOptions) => ImapMailboxSyncClient;
}) {
  const emailAccount = await getImapEmailAccountForSync(emailAccountId);

  if (!emailAccount) {
    throw new Error("IMAP email account not found");
  }

  if (!isImapProvider(emailAccount.account?.provider)) {
    throw new Error("Email account is not an IMAP account");
  }

  if (emailAccount.account.disconnectedAt) {
    throw new Error("Email account is disconnected");
  }

  const settings = await getImapConnectionSettingsForEmail({ emailAccountId });
  const provider = new ImapProvider(settings, logger);
  const tier = getUserTier(emailAccount.user.premium);
  const userHasAiAccess = hasAiAccess(tier, !!emailAccount.user.aiApiKey);
  const hasAutomationRules = emailAccount.rules.length > 0;
  const hasFilingEnabled =
    emailAccount.filingEnabled && !!emailAccount.filingPrompt;
  const shouldProcessMessages =
    userHasAiAccess && (hasAutomationRules || hasFilingEnabled);

  return syncImapMailbox({
    emailAccountId,
    mailbox,
    cursor: parseImapSyncCursor(emailAccount.imapSyncCursor),
    client: createClient({
      host: settings.imap.host,
      port: settings.imap.port,
      secure: settings.imap.secure,
      auth: {
        user: settings.username,
        pass: settings.password,
      },
      logger: false,
      connectionTimeout: settings.timeoutMs,
      greetingTimeout: settings.timeoutMs,
      socketTimeout: settings.timeoutMs,
    }),
    maxMessages,
    logger,
    saveCursor: (cursor) => saveImapSyncCursor(emailAccountId, cursor),
    processMessage: async (message) => {
      if (!shouldProcessMessages) return;

      const messageLogger = logger.with({
        messageId: message.id,
        threadId: message.threadId,
      });

      await processHistoryItem(
        {
          messageId: message.id,
          threadId: message.threadId,
          message,
        },
        {
          provider,
          emailAccount,
          hasAutomationRules,
          hasAiAccess: userHasAiAccess,
          rules: emailAccount.rules,
          logger: messageLogger,
        },
      );
    },
  });
}

export async function syncImapMailbox({
  emailAccountId,
  mailbox = DEFAULT_MAILBOX,
  cursor,
  client,
  processMessage,
  saveCursor,
  logger,
  maxMessages = DEFAULT_MAX_MESSAGES,
}: {
  emailAccountId: string;
  mailbox?: string;
  cursor: ImapSyncCursor | null;
  client: ImapMailboxSyncClient;
  processMessage: (message: ParsedMessage) => Promise<void> | void;
  saveCursor: (cursor: ImapSyncCursor) => Promise<void> | void;
  logger: Logger;
  maxMessages?: number;
}): Promise<ImapSyncResult> {
  await client.connect();

  try {
    const uidValidity = await getUidValidity(client, mailbox);
    const mailboxCursor = cursor?.mailboxes?.[mailbox];
    const uidValidityChanged =
      !!mailboxCursor && mailboxCursor.uidValidity !== uidValidity;
    const lastSyncedUid = uidValidityChanged
      ? 0
      : mailboxCursor?.lastUid && mailboxCursor.lastUid > 0
        ? mailboxCursor.lastUid
        : 0;

    const allUids = await withMailbox(client, mailbox, async () => {
      const uids = await client.search({ all: true }, { uid: true });
      return uids || [];
    });

    const newUids = allUids
      .filter((uid) => uid > lastSyncedUid)
      .sort((left, right) => left - right)
      .slice(0, maxMessages);

    const lastUid = newUids.at(-1) ?? lastSyncedUid;

    if (newUids.length) {
      const messages = await fetchMessagesByUid(client, mailbox, newUids);

      for (const message of messages) {
        try {
          await processMessage(message);
        } catch (error) {
          logger.error("Error processing IMAP message", {
            emailAccountId,
            mailbox,
            messageId: message.id,
            error,
          });
        }
      }
    }

    const nextCursor = updateMailboxCursor(cursor, mailbox, {
      uidValidity,
      lastUid,
      syncedAt: new Date().toISOString(),
    });

    await saveCursor(nextCursor);

    return {
      emailAccountId,
      mailbox,
      processed: newUids.length,
      lastUid,
      uidValidity,
      uidValidityChanged,
    };
  } finally {
    if (client.logout) {
      await client.logout().catch(() => client.close());
    } else {
      client.close();
    }
  }
}

export async function pollImapEmailAccounts({
  emailAccountIds,
  logger,
  syncAccount = syncImapAccount,
}: {
  emailAccountIds: string[];
  logger: Logger;
  syncAccount?: (options: {
    emailAccountId: string;
    logger: Logger;
  }) => Promise<ImapSyncResult>;
}) {
  const results: Array<
    | ({ status: "success" } & ImapSyncResult)
    | {
        emailAccountId: string;
        status: "error";
        message: string;
        errorDetails?: string;
      }
  > = [];

  for (const emailAccountId of emailAccountIds) {
    try {
      const result = await syncAccount({ emailAccountId, logger });
      results.push({ status: "success", ...result });
    } catch (error) {
      logger.error("Error polling IMAP account", { emailAccountId, error });
      results.push({
        emailAccountId,
        status: "error",
        message: "Failed to poll IMAP account.",
        errorDetails: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

function createDefaultClient(options: ImapFlowOptions): ImapMailboxSyncClient {
  return new ImapFlow(options) as unknown as ImapMailboxSyncClient;
}

async function getImapEmailAccountForSync(emailAccountId: string) {
  return prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      id: true,
      email: true,
      about: true,
      multiRuleSelectionEnabled: true,
      sensitiveDataPolicy: true,
      timezone: true,
      calendarBookingLink: true,
      draftReplyConfidence: true,
      autoCategorizeSenders: true,
      filingEnabled: true,
      filingPrompt: true,
      filingConfirmationSendEmail: true,
      imapSyncCursor: true,
      account: {
        select: {
          provider: true,
          disconnectedAt: true,
        },
      },
      rules: {
        where: { enabled: true },
        include: {
          actions: true,
        },
      },
      user: {
        select: {
          aiApiKey: true,
          premium: {
            select: premiumEntitlementSelect,
          },
        },
      },
    },
  } as Parameters<typeof prisma.emailAccount.findUnique>[0]);
}

function parseImapSyncCursor(value: unknown): ImapSyncCursor | null {
  if (!value || typeof value !== "object") return null;

  const mailboxes = (value as ImapSyncCursor).mailboxes;
  if (!mailboxes || typeof mailboxes !== "object") return null;

  const parsedMailboxes: NonNullable<ImapSyncCursor["mailboxes"]> = {};

  for (const [mailbox, mailboxCursor] of Object.entries(mailboxes)) {
    if (!mailboxCursor || typeof mailboxCursor !== "object") continue;

    const uidValidity = (mailboxCursor as { uidValidity?: unknown })
      .uidValidity;
    const lastUid = (mailboxCursor as { lastUid?: unknown }).lastUid;
    const syncedAt = (mailboxCursor as { syncedAt?: unknown }).syncedAt;

    if (
      (typeof uidValidity === "string" || typeof uidValidity === "number") &&
      typeof lastUid === "number" &&
      typeof syncedAt === "string"
    ) {
      parsedMailboxes[mailbox] = {
        uidValidity: String(uidValidity),
        lastUid,
        syncedAt,
      };
    }
  }

  return { mailboxes: parsedMailboxes };
}

async function saveImapSyncCursor(
  emailAccountId: string,
  cursor: ImapSyncCursor,
) {
  await prisma.emailAccount.update({
    where: { id: emailAccountId },
    data: { imapSyncCursor: cursor },
  } as Parameters<typeof prisma.emailAccount.update>[0]);
}

async function getUidValidity(
  client: ImapMailboxSyncClient,
  mailbox: string,
): Promise<string> {
  const status = await client.status?.(mailbox, { uidValidity: true });
  if (status?.uidValidity !== undefined) return String(status.uidValidity);

  const openedMailbox = await client.mailboxOpen?.(mailbox, { readOnly: true });
  const uidValidity = (openedMailbox as { uidValidity?: unknown } | undefined)
    ?.uidValidity;
  await client.mailboxClose?.();

  if (uidValidity === undefined) {
    throw new Error(`IMAP UIDVALIDITY not available for mailbox: ${mailbox}`);
  }

  return String(uidValidity);
}

async function fetchMessagesByUid(
  client: ImapMailboxSyncClient,
  mailbox: string,
  uids: number[],
) {
  if (!uids.length) return [];

  return withMailbox(client, mailbox, async () => {
    const messages: ParsedMessage[] = [];

    for await (const message of client.fetch(
      uids,
      {
        uid: true,
        flags: true,
        internalDate: true,
        size: true,
        source: true,
      },
      { uid: true },
    )) {
      if (!message.source) continue;

      messages.push(
        await parseImapMessage({
          id: formatImapMessageId(mailbox, message.uid),
          mailbox,
          uid: message.uid,
          source: message.source,
          flags: message.flags,
          internalDate: message.internalDate,
          size: message.size,
        }),
      );
    }

    return messages;
  });
}

async function withMailbox<T>(
  client: ImapMailboxSyncClient,
  mailbox: string,
  fn: () => Promise<T>,
) {
  const lock = client.getMailboxLock
    ? await client.getMailboxLock(mailbox, { readOnly: true })
    : undefined;

  if (!lock) await client.mailboxOpen?.(mailbox, { readOnly: true });

  try {
    return await fn();
  } finally {
    if (lock) {
      lock.release();
    } else {
      await client.mailboxClose?.();
    }
  }
}

function updateMailboxCursor(
  cursor: ImapSyncCursor | null,
  mailbox: string,
  mailboxCursor: NonNullable<ImapSyncCursor["mailboxes"]>[string],
): ImapSyncCursor {
  return {
    ...cursor,
    mailboxes: {
      ...(cursor?.mailboxes || {}),
      [mailbox]: mailboxCursor,
    },
  };
}

function formatImapMessageId(mailbox: string, uid: number) {
  return `${encodeURIComponent(mailbox)}:${uid}`;
}
