"use server";

import { actionClientUser } from "@/utils/actions/safe-action";
import {
  connectImapMailboxBody,
  connectStratoMailboxBody,
  type ConnectImapMailboxBody,
} from "@/utils/actions/imap-connection.validation";
import { SafeError } from "@/utils/error";
import {
  type MailboxConnectionSettings,
  verifyMailboxConnection,
} from "@/utils/email/imap/connection";
import { STRATO_IMAP_PRESET } from "@/utils/email/imap-presets";
import { IMAP_PROVIDER } from "@/utils/email/provider-types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

export const connectImapMailboxAction = actionClientUser
  .metadata({ name: "connectImapMailbox" })
  .inputSchema(connectImapMailboxBody)
  .action(async ({ ctx: { userId, logger }, parsedInput }) =>
    connectMailbox({ userId, logger, input: parsedInput }),
  );

export const connectStratoMailboxAction = actionClientUser
  .metadata({ name: "connectStratoMailbox" })
  .inputSchema(connectStratoMailboxBody)
  .action(async ({ ctx: { userId, logger }, parsedInput }) =>
    connectMailbox({
      userId,
      logger,
      input: { ...parsedInput, preset: "strato" },
    }),
  );

async function connectMailbox({
  userId,
  logger,
  input,
}: {
  userId: string;
  logger: Logger;
  input: ConnectImapMailboxBody;
}) {
  const email = input.email;
  const connectionSettings = getMailboxConnectionSettings(input);

  const [existingEmailAccount, existingImapAccount] = await Promise.all([
    prisma.emailAccount.findUnique({
      where: { email },
      select: {
        id: true,
        userId: true,
        account: {
          select: {
            id: true,
            provider: true,
          },
        },
      },
    }),
    prisma.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: IMAP_PROVIDER,
          providerAccountId: email,
        },
      },
      select: {
        id: true,
        userId: true,
      },
    }),
  ]);

  if (existingEmailAccount?.userId && existingEmailAccount.userId !== userId) {
    logger.warn(
      "IMAP mailbox connection rejected: email owned by another user",
      {
        existingUserId: existingEmailAccount.userId,
        targetUserId: userId,
      },
    );
    throw new SafeError("Mailbox is already connected to another user.");
  }

  if (existingImapAccount?.userId && existingImapAccount.userId !== userId) {
    logger.warn(
      "IMAP mailbox connection rejected: IMAP account owned by another user",
      {
        existingUserId: existingImapAccount.userId,
        targetUserId: userId,
      },
    );
    throw new SafeError("Mailbox is already connected to another user.");
  }

  if (
    existingEmailAccount &&
    existingEmailAccount.account.provider !== IMAP_PROVIDER
  ) {
    throw new SafeError("Mailbox is already connected with another provider.");
  }

  await verifyMailboxConnection(connectionSettings);

  if (existingEmailAccount) {
    await prisma.account.update({
      where: { id: existingEmailAccount.account.id },
      data: {
        provider: IMAP_PROVIDER,
        providerAccountId: email,
        type: IMAP_PROVIDER,
        disconnectedAt: null,
      },
    });
    await prisma.emailConnection.upsert({
      where: { emailAccountId: existingEmailAccount.id },
      create: {
        ...getEmailConnectionData(input, connectionSettings),
        emailAccountId: existingEmailAccount.id,
      },
      update: getEmailConnectionData(input, connectionSettings),
    });

    return {
      status: "updated" as const,
      emailAccountId: existingEmailAccount.id,
      email,
    };
  }

  const emailAccount = await prisma.emailAccount.create({
    data: {
      email,
      user: { connect: { id: userId } },
      account: existingImapAccount
        ? { connect: { id: existingImapAccount.id } }
        : {
            create: {
              userId,
              provider: IMAP_PROVIDER,
              providerAccountId: email,
              type: IMAP_PROVIDER,
              disconnectedAt: null,
            },
          },
    },
    select: { id: true, email: true },
  });

  await prisma.emailConnection.create({
    data: {
      ...getEmailConnectionData(input, connectionSettings),
      emailAccountId: emailAccount.id,
    },
  });

  return {
    status: "created" as const,
    emailAccountId: emailAccount.id,
    email: emailAccount.email,
  };
}

function getMailboxConnectionSettings(
  input: ConnectImapMailboxBody,
): MailboxConnectionSettings {
  if (input.preset === "strato") {
    return {
      imap: STRATO_IMAP_PRESET.imap,
      smtp: STRATO_IMAP_PRESET.smtp,
      username: input.email,
      password: input.password,
    };
  }

  return {
    imap: {
      host: input.imapHost,
      port: input.imapPort,
      secure: input.imapSecure,
    },
    smtp: {
      host: input.smtpHost,
      port: input.smtpPort,
      secure: input.smtpSecure,
    },
    username: input.username,
    password: input.password,
  };
}

function getEmailConnectionData(
  input: ConnectImapMailboxBody,
  settings: MailboxConnectionSettings,
) {
  return {
    protocol: IMAP_PROVIDER,
    preset: input.preset,
    imapHost: settings.imap.host,
    imapPort: settings.imap.port,
    imapSecure: settings.imap.secure,
    smtpHost: settings.smtp.host,
    smtpPort: settings.smtp.port,
    smtpSecure: settings.smtp.secure,
    username: settings.username,
    password: settings.password,
    isConnected: true,
    syncCursor: null,
    lastSyncedAt: null,
  };
}
