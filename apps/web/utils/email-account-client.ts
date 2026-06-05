import prisma from "@/utils/prisma";
import {
  getAccessTokenFromClient,
  getGmailClientWithRefresh,
} from "@/utils/gmail/client";
import {
  getAccessTokenFromClient as getOutlookAccessToken,
  getOutlookClientWithRefresh,
} from "@/utils/outlook/client";
import { SafeError } from "@/utils/error";
import type { MailboxConnectionSettings } from "@/utils/email/imap/connection";
import type { Logger } from "@/utils/logger";

export async function getGmailClientForEmail({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  const tokens = await getTokens({ emailAccountId });
  const gmail = getGmailClientWithRefresh({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: tokens.expiresAt,
    emailAccountId,
    logger,
  });
  return gmail;
}

export async function getGmailAndAccessTokenForEmail({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  const tokens = await getTokens({ emailAccountId });
  const gmail = await getGmailClientWithRefresh({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: tokens.expiresAt,
    emailAccountId,
    logger,
  });
  const accessToken = getAccessTokenFromClient(gmail);
  return { gmail, accessToken, tokens };
}

export async function getOutlookClientForEmail({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  const tokens = await getTokens({ emailAccountId });
  const outlook = await getOutlookClientWithRefresh({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: tokens.expiresAt,
    emailAccountId,
    logger,
  });
  return outlook;
}

export async function getOutlookAndAccessTokenForEmail({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  const tokens = await getTokens({ emailAccountId });
  const outlook = await getOutlookClientWithRefresh({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: tokens.expiresAt,
    emailAccountId,
    logger,
  });
  const accessToken = getOutlookAccessToken(outlook);
  return { outlook, accessToken, tokens };
}

export async function getImapConnectionSettingsForEmail({
  emailAccountId,
}: {
  emailAccountId: string;
}): Promise<MailboxConnectionSettings> {
  const emailConnection = await prisma.emailConnection.findUnique({
    where: { emailAccountId },
    select: {
      imapHost: true,
      imapPort: true,
      imapSecure: true,
      smtpHost: true,
      smtpPort: true,
      smtpSecure: true,
      username: true,
      password: true,
      isConnected: true,
    },
  });

  if (!emailConnection) {
    throw new SafeError("IMAP connection not found", 404);
  }

  if (!emailConnection.isConnected) {
    throw new SafeError("Email account is disconnected", 403);
  }

  return {
    imap: {
      host: emailConnection.imapHost,
      port: emailConnection.imapPort,
      secure: emailConnection.imapSecure,
    },
    smtp: {
      host: emailConnection.smtpHost,
      port: emailConnection.smtpPort,
      secure: emailConnection.smtpSecure,
    },
    username: emailConnection.username,
    password: emailConnection.password,
  };
}

export async function getOutlookClientForEmailId({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      account: {
        select: { access_token: true, refresh_token: true, expires_at: true },
      },
    },
  });
  const outlook = await getOutlookClientWithRefresh({
    accessToken: account?.account.access_token,
    refreshToken: account?.account.refresh_token || "",
    expiresAt: account?.account.expires_at?.getTime() ?? null,
    emailAccountId,
    logger,
  });
  return outlook;
}

async function getTokens({ emailAccountId }: { emailAccountId: string }) {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      account: {
        select: {
          access_token: true,
          refresh_token: true,
          expires_at: true,
          scope: true,
          disconnectedAt: true,
        },
      },
    },
  });

  if (emailAccount?.account.disconnectedAt) {
    throw new SafeError("Email account is disconnected", 403);
  }

  return {
    accessToken: emailAccount?.account.access_token,
    refreshToken: emailAccount?.account.refresh_token,
    expiresAt: emailAccount?.account.expires_at?.getTime() ?? null,
    scope: emailAccount?.account.scope,
  };
}
