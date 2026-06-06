"use server";

import { z } from "zod";
import prisma from "@/utils/prisma";
import { sendEmailBody } from "@/utils/gmail/mail";
import { actionClient } from "@/utils/actions/safe-action";
import { SafeError } from "@/utils/error";
import { createEmailProvider } from "@/utils/email/provider";
import {
  IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE,
  isImapProvider,
  supportsProviderCapability,
} from "@/utils/email/provider-types";
import { ActionType } from "@/generated/prisma/enums";
import { extractEmailAddress } from "@/utils/email";

const isStatusOk = (status: number) => status >= 200 && status < 300;

export const archiveThreadAction = actionClient
  .metadata({ name: "archiveThread" })
  .inputSchema(
    z.object({ threadId: z.string(), labelId: z.string().optional() }),
  )
  .action(
    async ({
      ctx: { emailAccountId, emailAccount, provider, logger },
      parsedInput: { threadId, labelId },
    }) => {
      if (!supportsProviderCapability(provider, "mailboxArchive")) {
        throw new SafeError(IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE);
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      try {
        await emailProvider.archiveThreadWithLabel(
          threadId,
          emailAccount.email,
          labelId,
        );
      } catch (error) {
        logger.error("Failed to archive thread", { error });
        throw new SafeError("Failed to archive email. Please try again.");
      }
    },
  );

export const trashThreadAction = actionClient
  .metadata({ name: "trashThread" })
  .inputSchema(z.object({ threadId: z.string() }))
  .action(
    async ({
      ctx: { emailAccountId, emailAccount, provider, logger },
      parsedInput: { threadId },
    }) => {
      if (!supportsProviderCapability(provider, "mailboxTrash")) {
        throw new SafeError(IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE);
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      try {
        await emailProvider.trashThread(threadId, emailAccount.email, "user");
      } catch (error) {
        logger.error("Failed to trash thread", { error });
        throw new SafeError("Failed to delete email. Please try again.");
      }
    },
  );

export const markReadThreadAction = actionClient
  .metadata({ name: "markReadThread" })
  .inputSchema(z.object({ threadId: z.string(), read: z.boolean() }))
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { threadId, read },
    }) => {
      if (
        !supportsProviderCapability(
          provider,
          read ? "mailboxMarkRead" : "mailboxMarkUnread",
        )
      ) {
        throw new SafeError(IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE);
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      try {
        await emailProvider.markReadThread(threadId, read);
      } catch (error) {
        logger.error("Failed to mark thread read state", { error });
        throw new SafeError(
          `Failed to mark email as ${read ? "read" : "unread"}. Please try again.`,
        );
      }
    },
  );

export const createAutoArchiveFilterAction = actionClient
  .metadata({ name: "createAutoArchiveFilter" })
  .inputSchema(
    z.object({
      from: z.string(),
      gmailLabelId: z.string().optional(),
      labelName: z.string().optional(),
    }),
  )
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { from, gmailLabelId, labelName },
    }) => {
      if (isImapProvider(provider)) {
        await upsertAppSideSenderCleanupRule({
          emailAccountId,
          from,
          action:
            gmailLabelId || labelName
              ? {
                  type: ActionType.MOVE_FOLDER,
                  folderId: gmailLabelId,
                  folderName: labelName,
                }
              : { type: ActionType.ARCHIVE },
        });
        return;
      }

      if (!supportsProviderCapability(provider, "providerNativeFilters")) {
        throw new SafeError(IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE);
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      await emailProvider.createAutoArchiveFilter({
        from,
        gmailLabelId,
        labelName,
      });
    },
  );

export const createFilterAction = actionClient
  .metadata({ name: "createFilter" })
  .inputSchema(
    z.object({
      from: z.string(),
      gmailLabelId: z.string(),
      labelName: z.string().optional(),
    }),
  )
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { from, gmailLabelId, labelName },
    }) => {
      if (isImapProvider(provider)) {
        await upsertAppSideSenderCleanupRule({
          emailAccountId,
          from,
          action: {
            type: ActionType.MOVE_FOLDER,
            folderId: gmailLabelId,
            folderName: labelName,
          },
        });
        return;
      }

      if (!supportsProviderCapability(provider, "providerNativeFilters")) {
        throw new SafeError(IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE);
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      const res = await emailProvider.createFilter({
        from,
        addLabelIds: [gmailLabelId],
      });

      if (!isStatusOk(res.status)) {
        logger.error("Failed to create filter", {
          from,
          gmailLabelId,
          status: res.status,
        });
        throw new SafeError("Failed to create filter");
      }
    },
  );

export const deleteFilterAction = actionClient
  .metadata({ name: "deleteFilter" })
  .inputSchema(
    z.object({ id: z.string().optional(), from: z.string().optional() }),
  )
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { id, from },
    }) => {
      if (isImapProvider(provider)) {
        await deleteAppSideSenderCleanupRule({ emailAccountId, id, from });
        return;
      }

      if (!id) throw new SafeError("Filter id is required.");

      if (!supportsProviderCapability(provider, "providerNativeFilters")) {
        throw new SafeError(IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE);
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      const res = await emailProvider.deleteFilter(id);

      if (!isStatusOk(res.status)) {
        logger.error("Failed to delete filter", {
          filterId: id,
          status: res.status,
        });
        throw new SafeError("Failed to delete filter");
      }
    },
  );

export const createLabelAction = actionClient
  .metadata({ name: "createLabel" })
  .inputSchema(
    z.object({ name: z.string(), description: z.string().optional() }),
  )
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { name, description },
    }) => {
      if (!supportsProviderCapability(provider, "labelActions")) {
        throw new SafeError(IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE);
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });
      const label = await emailProvider.createLabel(name, description);
      return label;
    },
  );

export const updateLabelsAction = actionClient
  .metadata({ name: "updateLabels" })
  .inputSchema(
    z.object({
      labels: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          enabled: z.boolean(),
          gmailLabelId: z.string(),
        }),
      ),
    }),
  )
  .action(async ({ ctx: { emailAccountId }, parsedInput: { labels } }) => {
    const enabledLabels = labels.filter((label) => label.enabled);
    const disabledLabels = labels.filter((label) => !label.enabled);

    await prisma.$transaction([
      ...enabledLabels.map((label) => {
        const { name, description, enabled, gmailLabelId } = label;

        return prisma.label.upsert({
          where: { name_emailAccountId: { name, emailAccountId } },
          create: {
            gmailLabelId,
            name,
            description,
            enabled,
            emailAccountId,
          },
          update: {
            name,
            description,
            enabled,
          },
        });
      }),
      prisma.label.deleteMany({
        where: {
          emailAccountId,
          name: { in: disabledLabels.map((label) => label.name) },
        },
      }),
    ]);
  });

export const sendEmailAction = actionClient
  .metadata({ name: "sendEmail" })
  .inputSchema(sendEmailBody)
  .action(
    async ({ ctx: { emailAccountId, provider, logger }, parsedInput }) => {
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      const result = await emailProvider.sendEmailWithHtml(parsedInput);

      return {
        success: true,
        messageId: result.messageId,
        threadId: result.threadId,
      };
    },
  );

type AppSideSenderCleanupAction =
  | { type: typeof ActionType.ARCHIVE }
  | {
      type: typeof ActionType.MOVE_FOLDER;
      folderId?: string | null;
      folderName?: string | null;
    };

async function upsertAppSideSenderCleanupRule({
  emailAccountId,
  from,
  action,
}: {
  emailAccountId: string;
  from: string;
  action: AppSideSenderCleanupAction;
}) {
  const sender = extractEmailAddress(from).trim().toLowerCase();
  if (!sender) throw new SafeError("A valid sender email is required.");

  const name = getSenderCleanupRuleName(sender);
  const actionData = {
    emailAccountId,
    type: action.type,
    folderId:
      action.type === ActionType.MOVE_FOLDER ? (action.folderId ?? null) : null,
    folderName:
      action.type === ActionType.MOVE_FOLDER
        ? (action.folderName ?? null)
        : null,
  };

  return prisma.rule.upsert({
    where: { name_emailAccountId: { name, emailAccountId } },
    create: {
      name,
      emailAccountId,
      enabled: true,
      automate: true,
      runOnThreads: false,
      from: sender,
      actions: { createMany: { data: [actionData] } },
    },
    update: {
      enabled: true,
      automate: true,
      runOnThreads: false,
      instructions: null,
      from: sender,
      to: null,
      subject: null,
      body: null,
      systemType: null,
      groupId: null,
      actions: {
        deleteMany: {},
        createMany: { data: [actionData] },
      },
    },
    include: { actions: true },
  });
}

async function deleteAppSideSenderCleanupRule({
  emailAccountId,
  id,
  from,
}: {
  emailAccountId: string;
  id?: string;
  from?: string;
}) {
  if (id) {
    await prisma.rule.delete({
      where: { id_emailAccountId: { id, emailAccountId } },
    });
    return;
  }

  const sender = from ? extractEmailAddress(from).trim().toLowerCase() : "";
  if (!sender) throw new SafeError("A valid sender email is required.");

  await prisma.rule.deleteMany({
    where: { emailAccountId, name: getSenderCleanupRuleName(sender) },
  });
}

function getSenderCleanupRuleName(sender: string) {
  return `Sender cleanup: ${sender}`;
}
