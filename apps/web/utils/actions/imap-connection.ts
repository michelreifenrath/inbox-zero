"use server";

import { actionClientUser } from "@/utils/actions/safe-action";
import { connectStratoMailboxBody } from "@/utils/actions/imap-connection.validation";
import { SafeError } from "@/utils/error";
import { verifyMailboxConnection } from "@/utils/email/imap/connection";
import { STRATO_IMAP_PRESET } from "@/utils/email/imap-presets";
import { IMAP_PROVIDER } from "@/utils/email/provider-types";
import prisma from "@/utils/prisma";

const STRATO_PRESET = "strato";

export const connectStratoMailboxAction = actionClientUser
  .metadata({ name: "connectStratoMailbox" })
  .inputSchema(connectStratoMailboxBody)
  .action(async ({ ctx: { userId, logger }, parsedInput }) => {
    const email = parsedInput.email;

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

    if (
      existingEmailAccount?.userId &&
      existingEmailAccount.userId !== userId
    ) {
      logger.warn(
        "STRATO mailbox connection rejected: email owned by another user",
        {
          existingUserId: existingEmailAccount.userId,
          targetUserId: userId,
        },
      );
      throw new SafeError("Mailbox is already connected to another user.");
    }

    if (existingImapAccount?.userId && existingImapAccount.userId !== userId) {
      logger.warn(
        "STRATO mailbox connection rejected: IMAP account owned by another user",
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
      throw new SafeError(
        "Mailbox is already connected with another provider.",
      );
    }

    await verifyMailboxConnection({
      imap: STRATO_IMAP_PRESET.imap,
      smtp: STRATO_IMAP_PRESET.smtp,
      username: email,
      password: parsedInput.password,
    });

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
          ...getStratoEmailConnectionData(email, parsedInput.password),
          emailAccountId: existingEmailAccount.id,
        },
        update: getStratoEmailConnectionData(email, parsedInput.password),
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
        ...getStratoEmailConnectionData(email, parsedInput.password),
        emailAccountId: emailAccount.id,
      },
    });

    return {
      status: "created" as const,
      emailAccountId: emailAccount.id,
      email: emailAccount.email,
    };
  });

function getStratoEmailConnectionData(email: string, password: string) {
  return {
    protocol: IMAP_PROVIDER,
    preset: STRATO_PRESET,
    imapHost: STRATO_IMAP_PRESET.imap.host,
    imapPort: STRATO_IMAP_PRESET.imap.port,
    imapSecure: STRATO_IMAP_PRESET.imap.secure,
    smtpHost: STRATO_IMAP_PRESET.smtp.host,
    smtpPort: STRATO_IMAP_PRESET.smtp.port,
    smtpSecure: STRATO_IMAP_PRESET.smtp.secure,
    username: email,
    password,
    isConnected: true,
    syncCursor: null,
    lastSyncedAt: null,
  };
}
