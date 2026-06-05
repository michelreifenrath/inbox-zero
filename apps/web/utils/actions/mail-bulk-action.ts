"use server";

import { actionClient } from "@/utils/actions/safe-action";
import { bulkSenderActionSchema } from "@/utils/actions/mail-bulk-action.validation";
import { createEmailProvider } from "@/utils/email/provider";
import {
  IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE,
  supportsBulkSenderActions,
} from "@/utils/email/provider-types";
import { SafeError } from "@/utils/error";

export const bulkArchiveAction = actionClient
  .metadata({ name: "bulkArchive" })
  .inputSchema(bulkSenderActionSchema)
  .action(
    async ({
      ctx: { emailAccountId, provider, emailAccount, logger },
      parsedInput: { froms },
    }) => {
      if (!supportsBulkSenderActions(provider)) {
        throw new SafeError(IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE);
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      await emailProvider.bulkArchiveFromSenders(
        froms,
        emailAccount.email,
        emailAccountId,
      );
    },
  );

export const bulkTrashAction = actionClient
  .metadata({ name: "bulkTrash" })
  .inputSchema(bulkSenderActionSchema)
  .action(
    async ({
      ctx: { emailAccountId, provider, emailAccount, logger },
      parsedInput: { froms },
    }) => {
      if (!supportsBulkSenderActions(provider)) {
        throw new SafeError(IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE);
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      await emailProvider.bulkTrashFromSenders(
        froms,
        emailAccount.email,
        emailAccountId,
      );
    },
  );
