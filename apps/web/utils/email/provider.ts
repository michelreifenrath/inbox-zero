import {
  getGmailClientForEmail,
  getImapConnectionSettingsForEmail,
  getOutlookClientForEmail,
} from "@/utils/email-account-client";
import { SafeError } from "@/utils/error";
import { GmailProvider } from "@/utils/email/google";
import { ImapProvider } from "@/utils/email/imap/provider";
import { OutlookProvider } from "@/utils/email/microsoft";
import type { EmailProvider } from "@/utils/email/types";
import { isImapProvider } from "@/utils/email/provider-types";
import { assertProviderNotRateLimited } from "@/utils/email/rate-limit";
import { toRateLimitProvider } from "@/utils/email/rate-limit-mode-error";
import type { Logger } from "@/utils/logger";

export async function createEmailProvider({
  emailAccountId,
  provider,
  logger,
  disconnectedAt,
}: {
  emailAccountId: string;
  provider: string;
  logger: Logger;
  disconnectedAt?: Date | null;
}): Promise<EmailProvider> {
  if (disconnectedAt) {
    throw new SafeError("Email account is disconnected", 403);
  }

  if (isImapProvider(provider)) {
    const settings = await getImapConnectionSettingsForEmail({
      emailAccountId,
    });
    return new ImapProvider(settings, logger);
  }

  const rateLimitProvider = toRateLimitProvider(provider);
  if (!rateLimitProvider) throw new SafeError("Unsupported provider", 400);

  await assertProviderNotRateLimited({
    emailAccountId,
    provider: rateLimitProvider,
    logger,
    source: "create-email-provider",
  });

  if (rateLimitProvider === "google") {
    const client = await getGmailClientForEmail({ emailAccountId, logger });
    return new GmailProvider(client, logger, emailAccountId);
  }

  const client = await getOutlookClientForEmail({ emailAccountId, logger });
  return new OutlookProvider(client, logger);
}
