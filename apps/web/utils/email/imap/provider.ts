import "server-only";

import { randomUUID } from "node:crypto";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import type { Attachment as MailAttachment } from "nodemailer/lib/mailer";
import type { InboxZeroLabel } from "@/utils/label";
import type { ThreadsQuery } from "@/utils/threads/validation";
import type { OutlookFolder } from "@/utils/outlook/folders";
import type { ParsedMessage } from "@/utils/types";
import { shouldSkipAutoDraft } from "@/utils/auto-draft";
import { handlePreviousDraftDeletion } from "@/utils/ai/choose-rule/draft-management";
import { getLatestNonDraftMessage } from "@/utils/email/latest-message";
import { getMessageTimestamp } from "@/utils/email/message-timestamp";
import type {
  EmailFilter,
  EmailLabel,
  EmailProvider,
  EmailSignature,
  EmailThread,
  SentMessagePage,
} from "@/utils/email/types";
import type { MailboxConnectionSettings } from "@/utils/email/imap/connection";
import type { ImapSmtpClients } from "@/utils/email/imap/smtp";
import {
  buildReplyAllRecipients,
  formatCcList,
  mergeAndDedupeRecipients,
} from "@/utils/email/reply-all";
import {
  forwardSmtpEmail,
  replyToSmtpEmail,
  sendSmtpEmail,
  sendSmtpEmailWithHtml,
} from "@/utils/email/imap/smtp";
import { formatReplySubject } from "@/utils/email/subject";
import { buildThreadingHeaders } from "@/utils/email/threading";
import {
  getThreadIdFromHeaders,
  normalizeMessageId,
  parseImapAttachment,
  parseImapMessage,
} from "@/utils/email/imap/message-parser";
import { buildReplyMessageText } from "@/utils/gmail/mail";
import { createReplyContent } from "@/utils/gmail/reply";
import { convertEmailHtmlToText } from "@/utils/mail";
import { createScopedLogger, type Logger } from "@/utils/logger";

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_THREAD_SCAN_LIMIT = 100;
const INBOX = "INBOX";
const SENT_SPECIAL_USE = "\\Sent";
const ARCHIVE_SPECIAL_USE = "\\Archive";
const TRASH_SPECIAL_USE = "\\Trash";
const DRAFTS_SPECIAL_USE = "\\Drafts";
const ARCHIVE_FOLDER_NAMES = ["archive", "archives", "archiv"];
const TRASH_FOLDER_NAMES = [
  "trash",
  "deleted",
  "deleted items",
  "bin",
  "papierkorb",
  "gelöscht",
  "gelöschte elemente",
];
const DRAFT_FOLDER_NAMES = ["drafts", "draft", "entwürfe", "entwurf"];
const IMAP_DRAFT_ID_HEADER = "X-Inbox-Zero-Draft-Id";
const NON_SELECTABLE_FOLDER_FLAGS = new Set(["\\noselect", "\\nonexistent"]);

export type ImapProviderClient = {
  connect(): Promise<void>;
  close(): void;
  logout?(): Promise<void>;
  list(options?: unknown): Promise<ImapMailbox[]>;
  mailboxCreate?(path: string): Promise<unknown>;
  status?(
    path: string,
    query: {
      messages?: boolean;
      unseen?: boolean;
      uidNext?: boolean;
      uidValidity?: boolean;
    },
  ): Promise<{ messages?: number; unseen?: number }>;
  mailboxOpen?(
    path: string,
    options?: { readOnly?: boolean },
  ): Promise<unknown>;
  mailboxClose?(): Promise<unknown>;
  getMailboxLock?(
    path: string,
    options?: { readOnly?: boolean },
  ): Promise<{ release(): void }>;
  search(
    query: ImapSearchQuery,
    options?: { uid?: boolean },
  ): Promise<number[] | false>;
  fetch(
    range: number[] | string,
    query: ImapFetchQuery,
    options?: { uid?: boolean },
  ): AsyncIterable<ImapFetchMessage>;
  fetchOne?(
    seq: string | number,
    query: ImapFetchQuery,
    options?: { uid?: boolean },
  ): Promise<ImapFetchMessage | false>;
  messageMove(
    range: number[],
    destination: string,
    options?: { uid?: boolean },
  ): Promise<unknown | false>;
  messageFlagsAdd(
    range: number[],
    flags: string[],
    options?: { uid?: boolean },
  ): Promise<unknown | false>;
  messageFlagsRemove(
    range: number[],
    flags: string[],
    options?: { uid?: boolean },
  ): Promise<unknown | false>;
  messageDelete?(
    range: number[],
    options?: { uid?: boolean },
  ): Promise<unknown | false>;
  append?(
    path: string,
    content: string | Buffer,
    flags?: string[],
    idate?: Date | string,
  ): Promise<{ destination: string; uid?: number; seq?: number } | false>;
};

type ImapProviderClients = {
  createClient?: (options: ImapFlowOptions) => ImapProviderClient;
  createSmtpTransport?: ImapSmtpClients["createTransport"];
};

type ImapMailbox = {
  path: string;
  name?: string;
  delimiter?: string;
  parent?: string[];
  parentPath?: string;
  specialUse?: string;
  flags?: Set<string>;
  status?: { messages?: number; unseen?: number };
};

type ImapSearchQuery = {
  all?: boolean;
  from?: string;
  text?: string;
  before?: Date;
  since?: Date;
  seen?: boolean;
  header?: Record<string, string | boolean>;
  or?: ImapSearchQuery[];
};

type ImapFetchQuery = {
  uid?: boolean;
  flags?: boolean;
  internalDate?: boolean;
  size?: boolean;
  source?: boolean;
};

type ImapFetchMessage = {
  uid: number;
  flags?: Set<string>;
  internalDate?: Date | string;
  size?: number;
  source?: Buffer;
};

type MessagePageOptions = {
  mailbox?: string;
  allMailboxes?: boolean;
  query?: string;
  maxResults?: number;
  pageToken?: string;
  before?: Date;
  after?: Date;
  unreadOnly?: boolean;
  from?: string;
};

type PageToken = {
  mailbox?: string;
  allMailboxes?: boolean;
  offset: number;
};

export class ImapProvider implements EmailProvider {
  readonly name = "imap";
  private readonly settings: MailboxConnectionSettings;
  private readonly createClient: (
    options: ImapFlowOptions,
  ) => ImapProviderClient;
  private readonly logger: Logger;
  private readonly smtpClients: ImapSmtpClients;

  constructor(
    settings: MailboxConnectionSettings,
    logger?: Logger,
    clients: ImapProviderClients = {},
  ) {
    this.settings = settings;
    this.createClient = clients.createClient ?? createDefaultClient;
    this.smtpClients = clients.createSmtpTransport
      ? { createTransport: clients.createSmtpTransport }
      : {};
    this.logger = (logger || createScopedLogger("imap-provider")).with({
      provider: "imap",
    });
  }

  toJSON() {
    return { name: this.name, type: "ImapProvider" };
  }

  async getFolders(): Promise<OutlookFolder[]> {
    return this.withClient(async (client) => {
      const folders = await client.list({
        statusQuery: { messages: true, unseen: true },
      });
      return toFolderTree(folders);
    });
  }

  async getLabels(_options?: {
    includeHidden?: boolean;
  }): Promise<EmailLabel[]> {
    return this.withClient(async (client) => {
      const folders = await client.list({
        statusQuery: { messages: true, unseen: true },
      });
      return folders.map((folder) => ({
        id: folder.path,
        name:
          folder.name || getFolderDisplayName(folder.path, folder.delimiter),
        type: "folder",
        threadsTotal: folder.status?.messages,
      }));
    });
  }

  async getLabelById(labelId: string): Promise<EmailLabel | null> {
    const labels = await this.getLabels({ includeHidden: true });
    return labels.find((label) => label.id === labelId) || null;
  }

  async getLabelByName(name: string): Promise<EmailLabel | null> {
    const labels = await this.getLabels({ includeHidden: true });
    return (
      labels.find((label) => label.name === name || label.id === name) || null
    );
  }

  async getInboxStats(): Promise<{ total: number; unread: number }> {
    return this.withClient(async (client) => {
      const status = client.status
        ? await client.status(INBOX, { messages: true, unseen: true })
        : undefined;
      return {
        total: status?.messages || 0,
        unread: status?.unseen || 0,
      };
    });
  }

  async getInboxMessages(
    maxResults = DEFAULT_PAGE_SIZE,
  ): Promise<ParsedMessage[]> {
    const page = await this.getMessagePage({ mailbox: INBOX, maxResults });
    return page.messages;
  }

  async getSentMessages(
    maxResults = DEFAULT_PAGE_SIZE,
  ): Promise<ParsedMessage[]> {
    return this.withClient(async (client) => {
      const mailbox = await this.findSentMailbox(client);
      const page = await this.getMessagePageWithClient(client, {
        mailbox,
        maxResults,
      });
      return page.messages;
    });
  }

  async getSentMessageIds(options: {
    maxResults: number;
    after?: Date;
    before?: Date;
    pageToken?: string;
  }): Promise<SentMessagePage> {
    return this.withClient(async (client) => {
      const mailbox = await this.findSentMailbox(client);
      const page = await this.getMessagePageWithClient(client, {
        mailbox,
        maxResults: options.maxResults,
        after: options.after,
        before: options.before,
        pageToken: options.pageToken,
      });
      return {
        messages: page.messages.map((message) => ({
          id: message.id,
          threadId: message.threadId,
        })),
        nextPageToken: page.nextPageToken,
      };
    });
  }

  async getMessagesWithPagination(options: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
    inboxOnly?: boolean;
    unreadOnly?: boolean;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    return this.getMessagePage({
      mailbox: options.inboxOnly === false ? undefined : INBOX,
      allMailboxes: options.inboxOnly === false,
      query: options.query,
      maxResults: options.maxResults,
      pageToken: options.pageToken,
      before: options.before,
      after: options.after,
      unreadOnly: options.unreadOnly,
    });
  }

  async searchMessages(options: {
    query: string;
    maxResults?: number;
    pageToken?: string;
    readState?: "read" | "unread";
    labelName?: string;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    return this.getMessagePage({
      mailbox: options.labelName || INBOX,
      query: options.query,
      maxResults: options.maxResults,
      pageToken: options.pageToken,
      unreadOnly: options.readState === "unread",
    });
  }

  async getMessagesFromSender(options: {
    senderEmail: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    return this.getMessagePage({
      mailbox: INBOX,
      from: options.senderEmail,
      maxResults: options.maxResults,
      pageToken: options.pageToken,
      before: options.before,
      after: options.after,
    });
  }

  async getMessagesWithAttachments(options: {
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const page = await this.getMessagePage({
      mailbox: INBOX,
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
    return {
      messages: page.messages.filter((message) => message.attachments?.length),
      nextPageToken: page.nextPageToken,
    };
  }

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const { mailbox, uid } = parseImapMessageId(messageId);
    return this.withClient((client) => this.fetchMessage(client, mailbox, uid));
  }

  async getMessagesBatch(messageIds: string[]): Promise<ParsedMessage[]> {
    const parsedIds = messageIds.map(parseImapMessageId);
    const groups = new Map<string, number[]>();
    for (const { mailbox, uid } of parsedIds) {
      groups.set(mailbox, [...(groups.get(mailbox) || []), uid]);
    }

    return this.withClient(async (client) => {
      const messagesByKey = new Map<string, ParsedMessage>();
      for (const [mailbox, uids] of groups) {
        const messages = await this.fetchMessagesByUid(client, mailbox, uids);
        for (const message of messages) {
          const { uid } = parseImapMessageId(message.id);
          messagesByKey.set(getImapMessageKey(mailbox, uid), message);
        }
      }
      return parsedIds
        .map(({ mailbox, uid }) =>
          messagesByKey.get(getImapMessageKey(mailbox, uid)),
        )
        .filter((message): message is ParsedMessage => Boolean(message));
    });
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string; size: number }> {
    const { mailbox, uid } = parseImapMessageId(messageId);
    return this.withClient(async (client) => {
      const raw = await this.fetchRawMessage(client, mailbox, uid);
      return parseImapAttachment(raw.source, attachmentId);
    });
  }

  async getMessageByRfc822MessageId(
    rfc822MessageId: string,
  ): Promise<ParsedMessage | null> {
    const normalized = normalizeMessageId(rfc822MessageId);
    if (!normalized) return null;

    return this.withClient(async (client) => {
      const folders = (await client.list()).filter(isSelectableFolder);
      for (const folder of folders) {
        const uids = await this.searchUids(client, folder.path, {
          header: { "message-id": `<${normalized}>` },
        });
        const [uid] = uids;
        if (uid) return this.fetchMessage(client, folder.path, uid);
      }
      return null;
    });
  }

  async getThreads(folderId?: string): Promise<EmailThread[]> {
    const page = await this.getMessagePage({
      mailbox: folderId || INBOX,
      maxResults: DEFAULT_THREAD_SCAN_LIMIT,
    });
    return buildThreads(page.messages);
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const messages = await this.getThreadMessages(threadId);
    if (!messages.length) {
      throw new Error(`IMAP thread not found: ${threadId}`);
    }
    return {
      id: threadId,
      messages,
      snippet: messages[0]?.snippet || "",
    };
  }

  async getThreadMessages(threadId: string): Promise<ParsedMessage[]> {
    return this.withClient((client) =>
      this.getThreadMessagesWithClient(client, threadId),
    );
  }

  async getThreadMessagesInInbox(threadId: string): Promise<ParsedMessage[]> {
    return this.withClient((client) =>
      this.getThreadMessagesFromMailboxes(client, threadId, [INBOX]),
    );
  }

  async getThreadsWithQuery(options: {
    query?: ThreadsQuery;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
    const page = await this.getMessagePage({
      mailbox: options.query?.labelId || INBOX,
      maxResults:
        options.maxResults || options.query?.limit || DEFAULT_PAGE_SIZE,
      pageToken: options.pageToken || options.query?.nextPageToken || undefined,
      from: options.query?.fromEmail || undefined,
      before: options.query?.before || undefined,
      after: options.query?.after || undefined,
      unreadOnly: options.query?.isUnread || undefined,
    });
    return {
      threads: buildThreads(page.messages),
      nextPageToken: page.nextPageToken,
    };
  }

  async getLatestMessageInThread(
    threadId: string,
  ): Promise<ParsedMessage | null> {
    return getLatestNonDraftMessage(await this.getThreadMessages(threadId));
  }

  async getLatestMessageFromThreadSnapshot(
    thread: Pick<EmailThread, "id" | "messages">,
  ): Promise<ParsedMessage | null> {
    return getLatestNonDraftMessage(thread.messages);
  }

  isReplyInThread(message: ParsedMessage): boolean {
    return Boolean(
      message.headers["in-reply-to"] || message.headers.references,
    );
  }

  isSentMessage(message: ParsedMessage): boolean {
    const folder = message.parentFolderId?.toLowerCase() || "";
    return folder.includes("sent");
  }

  async countReceivedMessages(
    senderEmail: string,
    threshold: number,
  ): Promise<number> {
    const page = await this.getMessagesFromSender({
      senderEmail,
      maxResults: threshold,
    });
    return page.messages.length;
  }

  async hasPreviousCommunicationsWithSenderOrDomain(options: {
    from: string;
    date: Date;
    messageId: string;
  }): Promise<boolean> {
    const page = await this.getMessagesFromSender({
      senderEmail: options.from,
      before: options.date,
      maxResults: 10,
    });
    return page.messages.some((message) => message.id !== options.messageId);
  }

  async checkIfReplySent(_senderEmail: string): Promise<boolean> {
    this.unsupported("checkIfReplySent");
  }

  async getPreviousConversationMessages(
    messageIds: string[],
  ): Promise<ParsedMessage[]> {
    return this.getMessagesBatch(messageIds);
  }

  async getOriginalMessage(
    originalMessageId: string | undefined,
  ): Promise<ParsedMessage | null> {
    if (!originalMessageId) return null;
    return this.getMessage(originalMessageId);
  }

  getAccessToken(): string {
    this.unsupported("getAccessToken");
  }

  async archiveMessage(messageId: string): Promise<void> {
    const { mailbox, uid } = parseImapMessageId(messageId);
    await this.withClient(async (client) => {
      const archiveMailbox = await this.findArchiveMailbox(client);
      await this.moveMessages(client, [{ mailbox, uid }], archiveMailbox);
    });
  }
  async archiveThread(threadId: string, _ownerEmail: string): Promise<void> {
    await this.archiveThreadMessages(threadId);
  }
  async archiveThreadWithLabel(
    threadId: string,
    _ownerEmail: string,
    _labelId?: string,
  ): Promise<void> {
    await this.archiveThreadMessages(threadId);
  }
  async blockUnsubscribedEmail(_messageId: string): Promise<void> {
    this.unsupported("blockUnsubscribedEmail");
  }
  async bulkArchiveFromSenders(
    _fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    this.unsupported("bulkArchiveFromSenders");
  }
  async bulkTrashFromSenders(
    _fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    this.unsupported("bulkTrashFromSenders");
  }
  async createAutoArchiveFilter(_options: {
    from: string;
    gmailLabelId?: string;
    labelName?: string;
  }): Promise<{ status: number }> {
    this.unsupported("createAutoArchiveFilter");
  }
  async createDraft(params: {
    to: string;
    subject: string;
    messageHtml: string;
    replyToMessageId?: string;
  }): Promise<{ id: string }> {
    return this.withClient(async (client) => {
      const draftsMailbox = await this.findDraftsMailbox(client);
      const draftId = createImapDraftId();
      let originalMessage: ParsedMessage | null = null;

      if (params.replyToMessageId) {
        originalMessage = await this.getMessage(params.replyToMessageId).catch(
          () => null,
        );
      }

      await this.appendDraftMessage(client, draftsMailbox, {
        draftId,
        to: params.to,
        from: this.settings.username,
        subject: params.subject,
        messageHtml: params.messageHtml,
        replyToEmail: originalMessage
          ? {
              headerMessageId: originalMessage.headers["message-id"] || "",
              references: originalMessage.headers.references,
            }
          : undefined,
      });

      return { id: draftId };
    });
  }
  async createFilter(_options: {
    from: string;
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }): Promise<{ status: number }> {
    this.unsupported("createFilter");
  }
  async createLabel(_name: string, _description?: string): Promise<EmailLabel> {
    this.unsupported("createLabel");
  }
  async deleteDraft(draftId: string): Promise<void> {
    await this.withClient(async (client) => {
      const draft = await this.findDraftById(client, draftId);
      if (!draft) return;
      await this.deleteDraftByUid(client, draft.mailbox, draft.uid);
    });
  }
  async deleteFilter(_id: string): Promise<{ status: number }> {
    this.unsupported("deleteFilter");
  }
  async deleteLabel(_labelId: string): Promise<void> {
    this.unsupported("deleteLabel");
  }
  async draftEmail(
    email: ParsedMessage,
    args: {
      to?: string;
      subject?: string;
      content: string;
      cc?: string;
      bcc?: string;
      attachments?: MailAttachment[];
    },
    userEmail: string,
    executedRule?: { id: string; threadId: string; emailAccountId: string },
  ): Promise<{ draftId: string }> {
    if (shouldSkipAutoDraft({ logger: this.logger, source: "imap" })) {
      return { draftId: "" };
    }

    const createDraft = () => this.createReplyDraft(email, args, userEmail);

    if (!executedRule) return createDraft();

    const [result] = await Promise.all([
      createDraft(),
      handlePreviousDraftDeletion({
        client: this,
        executedRule,
        logger: this.logger,
      }),
    ]);

    return result;
  }
  async forwardEmail(
    email: ParsedMessage,
    args: {
      to: string;
      cc?: string;
      bcc?: string;
      content?: string;
      from?: string;
    },
  ): Promise<void> {
    const parsedMessage = await this.getMessage(email.id);
    const attachments = await Promise.all(
      parsedMessage.attachments?.map(async (attachment) => {
        const attachmentData = await this.getAttachment(
          parsedMessage.id,
          attachment.attachmentId,
        );
        return {
          content: Buffer.from(attachmentData.data, "base64"),
          contentType: attachment.mimeType,
          filename: attachment.filename,
        };
      }) || [],
    );

    await forwardSmtpEmail(
      this.settings,
      parsedMessage,
      { ...args, attachments },
      this.smtpClients,
    );
  }
  async getDraft(draftId: string): Promise<ParsedMessage | null> {
    return this.withClient(async (client) => {
      const draft = await this.findDraftById(client, draftId);
      if (!draft) return null;
      return this.toDraftMessage(draft.message, draftId);
    });
  }
  async getDrafts(options?: { maxResults?: number }): Promise<ParsedMessage[]> {
    return this.withClient(async (client) => {
      const draftsMailbox = await this.findDraftsMailbox(client);
      const uids = await this.searchUids(client, draftsMailbox, { all: true });
      const sortedUids = [...uids].sort((left, right) => right - left);
      const messages = await this.fetchMessagesByUid(
        client,
        draftsMailbox,
        sortedUids.slice(0, options?.maxResults),
      );

      return messages.map((message) =>
        this.toDraftMessage(
          message,
          getDraftIdFromSource(message.id, message.headers["message-id"]),
        ),
      );
    });
  }
  async getFiltersList(): Promise<EmailFilter[]> {
    this.unsupported("getFiltersList");
  }
  async getOrCreateFolderIdByName(folderName: string): Promise<string> {
    return this.withClient((client) =>
      this.getOrCreateFolderIdByNameWithClient(client, folderName),
    );
  }
  async getOrCreateInboxZeroLabel(_key: InboxZeroLabel): Promise<EmailLabel> {
    this.unsupported("getOrCreateInboxZeroLabel");
  }
  async getSentThreadsExcluding(_options: {
    excludeToEmails?: string[];
    excludeFromEmails?: string[];
    maxResults?: number;
  }): Promise<EmailThread[]> {
    this.unsupported("getSentThreadsExcluding");
  }
  async getSignatures(): Promise<EmailSignature[]> {
    this.unsupported("getSignatures");
  }
  async getThreadsFromSenderWithSubject(
    _sender: string,
    _limit: number,
  ): Promise<Array<{ id: string; snippet: string; subject: string }>> {
    this.unsupported("getThreadsFromSenderWithSubject");
  }
  async getThreadsWithLabel(_options: {
    labelId: string;
    maxResults?: number;
  }): Promise<EmailThread[]> {
    this.unsupported("getThreadsWithLabel");
  }
  async getThreadsWithParticipant(_options: {
    participantEmail: string;
    maxThreads?: number;
  }): Promise<EmailThread[]> {
    this.unsupported("getThreadsWithParticipant");
  }
  async labelMessage(_options: {
    messageId: string;
    labelId: string;
    labelName: string | null;
  }): Promise<{ usedFallback?: boolean; actualLabelId?: string }> {
    this.unsupported("labelMessage");
  }
  async markRead(threadId: string): Promise<void> {
    await this.markReadThread(threadId, true);
  }
  async markReadThread(threadId: string, read: boolean): Promise<void> {
    await this.withClient(async (client) => {
      const messages = await this.getThreadMessagesWithClient(client, threadId);
      await this.updateMessageFlag(client, messages, "\\Seen", read);
    });
  }
  async markSpam(_threadId: string): Promise<void> {
    this.unsupported("markSpam");
  }
  async moveThreadToFolder(
    threadId: string,
    _ownerEmail: string,
    folderName: string,
  ): Promise<void> {
    await this.withClient(async (client) => {
      const folderPath = await this.getOrCreateFolderIdByNameWithClient(
        client,
        folderName,
      );
      const messages = await this.getThreadMessagesWithClient(client, threadId);
      await this.moveMessages(
        client,
        messages.map(({ id }) => parseImapMessageId(id)),
        folderPath,
      );
    });
  }
  async removeThreadLabel(_threadId: string, _labelId: string): Promise<void> {
    this.unsupported("removeThreadLabel");
  }
  async removeThreadLabels(
    _threadId: string,
    _labelIds: string[],
  ): Promise<void> {
    this.unsupported("removeThreadLabels");
  }
  async replyToEmail(
    email: ParsedMessage,
    content: string,
    options?: {
      replyTo?: string;
      from?: string;
      attachments?: MailAttachment[];
    },
  ): Promise<void> {
    await replyToSmtpEmail(
      this.settings,
      email,
      content,
      options,
      this.smtpClients,
    );
  }
  async sendDraft(
    draftId: string,
  ): Promise<{ messageId: string; threadId: string }> {
    return this.withClient(async (client) => {
      const draft = await this.findDraftById(client, draftId);
      if (!draft) throw new Error(`IMAP draft not found: ${draftId}`);

      const attachments = await this.getStoredDraftAttachments(
        client,
        draft.mailbox,
        draft.uid,
        draft.message.attachments,
      );
      const inReplyTo = draft.message.headers["in-reply-to"];
      const result = await sendSmtpEmailWithHtml(
        this.settings,
        {
          to: draft.message.headers.to,
          from: draft.message.headers.from || this.settings.username,
          cc: draft.message.headers.cc,
          bcc: draft.message.headers.bcc,
          replyTo: draft.message.headers["reply-to"],
          subject: draft.message.subject,
          messageHtml:
            draft.message.textHtml ||
            convertTextToHtml(draft.message.textPlain || ""),
          attachments,
          replyToEmail: inReplyTo
            ? {
                threadId: draft.message.threadId,
                headerMessageId: inReplyTo,
                references: removeReferenceId(
                  draft.message.headers.references,
                  inReplyTo,
                ),
              }
            : undefined,
        },
        this.smtpClients,
      );

      await this.deleteDraftByUid(client, draft.mailbox, draft.uid);
      return result;
    });
  }
  async sendEmail(args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
    attachments?: MailAttachment[];
  }): Promise<void> {
    await sendSmtpEmail(this.settings, args, this.smtpClients);
  }
  async sendEmailWithHtml(body: {
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
    attachments?: Array<{
      filename: string;
      content: string;
      contentType: string;
    }>;
  }): Promise<{ messageId: string; threadId: string }> {
    return sendSmtpEmailWithHtml(this.settings, body, this.smtpClients);
  }
  async starMessage(messageId: string): Promise<void> {
    const { mailbox, uid } = parseImapMessageId(messageId);
    await this.withClient((client) =>
      this.updateMessageFlag(client, [{ mailbox, uid }], "\\Flagged", true),
    );
  }
  async trashThread(
    threadId: string,
    _ownerEmail: string,
    _actionSource: "user" | "automation",
  ): Promise<void> {
    await this.withClient(async (client) => {
      const trashMailbox = await this.findTrashMailbox(client);
      const messages = await this.getThreadMessagesWithClient(client, threadId);
      await this.moveMessages(
        client,
        messages.map(({ id }) => parseImapMessageId(id)),
        trashMailbox,
      );
    });
  }
  async unwatchEmails(_subscriptionId?: string): Promise<void> {
    this.unsupported("unwatchEmails");
  }
  async updateDraft(
    draftId: string,
    params: { messageHtml?: string; subject?: string },
  ): Promise<void> {
    await this.withClient(async (client) => {
      const currentDraft = await this.findDraftById(client, draftId);
      if (!currentDraft) throw new Error(`IMAP draft not found: ${draftId}`);

      await this.appendDraftMessage(client, currentDraft.mailbox, {
        draftId,
        to: currentDraft.message.headers.to,
        from: currentDraft.message.headers.from || this.settings.username,
        cc: currentDraft.message.headers.cc,
        bcc: currentDraft.message.headers.bcc,
        replyTo: currentDraft.message.headers["reply-to"],
        subject: params.subject || currentDraft.message.subject,
        messageHtml:
          params.messageHtml ||
          currentDraft.message.textHtml ||
          convertTextToHtml(currentDraft.message.textPlain || ""),
        inReplyTo: currentDraft.message.headers["in-reply-to"],
        references: currentDraft.message.headers.references,
      });
      await this.deleteDraftByUid(
        client,
        currentDraft.mailbox,
        currentDraft.uid,
      );
    });
  }
  async watchEmails(): Promise<{
    expirationDate: Date;
    subscriptionId?: string;
  } | null> {
    this.unsupported("watchEmails");
  }

  private async getMessagePage(options: MessagePageOptions) {
    return this.withClient((client) =>
      this.getMessagePageWithClient(client, options),
    );
  }

  private async createReplyDraft(
    email: ParsedMessage,
    args: {
      to?: string;
      subject?: string;
      content: string;
      cc?: string;
      bcc?: string;
      attachments?: MailAttachment[];
    },
    userEmail: string,
  ) {
    const recipients = buildReplyAllRecipients(
      email.headers,
      args.to,
      userEmail,
    );
    const { html } = createReplyContent({
      textContent: args.content,
      message: email,
    });
    const draftId = createImapDraftId();

    await this.withClient(async (client) => {
      const draftsMailbox = await this.findDraftsMailbox(client);
      await this.appendDraftMessage(client, draftsMailbox, {
        draftId,
        to: recipients.to,
        from: this.settings.username,
        cc: formatCcList(mergeAndDedupeRecipients(recipients.cc, args.cc)),
        bcc: formatCcList(mergeAndDedupeRecipients([], args.bcc)),
        subject: args.subject || formatReplySubject(email.headers.subject),
        messageHtml: html,
        messageText: buildReplyMessageText({
          textContent: args.content,
          message: email,
        }),
        attachments: args.attachments,
        replyToEmail: {
          headerMessageId: email.headers["message-id"] || "",
          references: email.headers.references,
        },
      });
    });

    return { draftId };
  }

  private async appendDraftMessage(
    client: ImapProviderClient,
    draftsMailbox: string,
    options: {
      draftId: string;
      to: string;
      from?: string;
      cc?: string;
      bcc?: string;
      replyTo?: string;
      subject: string;
      messageHtml: string;
      messageText?: string;
      attachments?: MailAttachment[];
      replyToEmail?: { headerMessageId: string; references?: string };
      inReplyTo?: string;
      references?: string;
    },
  ) {
    if (!client.append) {
      throw new Error("IMAP provider cannot create drafts with this client.");
    }

    const source = await createDraftSource(options);
    const result = await client.append(
      draftsMailbox,
      source,
      ["\\Draft", "\\Seen"],
      new Date(),
    );
    if (result === false) {
      throw new Error(`IMAP draft append failed for ${draftsMailbox}.`);
    }
  }

  private async findDraftById(client: ImapProviderClient, draftId: string) {
    const draftsMailbox = await this.findDraftsMailbox(client);
    const uids = await this.searchUids(client, draftsMailbox, {
      or: [
        { header: { [IMAP_DRAFT_ID_HEADER]: draftId } },
        { header: { "message-id": `<${draftId}>` } },
      ],
    });
    const uid = [...uids].sort((left, right) => right - left)[0];
    if (!uid) return null;

    return {
      mailbox: draftsMailbox,
      uid,
      message: await this.fetchMessage(client, draftsMailbox, uid),
    };
  }

  private async deleteDraftByUid(
    client: ImapProviderClient,
    mailbox: string,
    uid: number,
  ) {
    if (!client.messageDelete) {
      throw new Error("IMAP provider cannot delete drafts with this client.");
    }

    await this.withMailbox(
      client,
      mailbox,
      async () => {
        const result = await client.messageDelete?.([uid], { uid: true });
        if (result === false) {
          throw new Error(`IMAP draft delete failed for ${mailbox}.`);
        }
      },
      { readOnly: false },
    );
  }

  private async getStoredDraftAttachments(
    client: ImapProviderClient,
    mailbox: string,
    uid: number,
    attachments: ParsedMessage["attachments"],
  ): Promise<MailAttachment[] | undefined> {
    if (!attachments?.length) return;

    const raw = await this.fetchRawMessage(client, mailbox, uid);
    return Promise.all(
      attachments.map(async (attachment) => {
        const attachmentData = await parseImapAttachment(
          raw.source,
          attachment.attachmentId,
        );
        return {
          content: Buffer.from(attachmentData.data, "base64"),
          contentType: attachment.mimeType,
          filename: attachment.filename,
        };
      }),
    );
  }

  private toDraftMessage(message: ParsedMessage, draftId: string) {
    return {
      ...message,
      id: draftId,
      labelIds: [...(message.labelIds || []), "DRAFT"],
    };
  }

  private async getOrCreateFolderIdByNameWithClient(
    client: ImapProviderClient,
    folderName: string,
  ) {
    const folderPath = normalizeFolderPath(folderName);
    const existingFolder = findFolderByPathOrName(
      await client.list(),
      folderPath,
    );
    if (existingFolder) return existingFolder.path;

    if (!client.mailboxCreate) {
      throw new Error("IMAP provider cannot create folders with this client.");
    }

    await client.mailboxCreate(folderPath);
    return folderPath;
  }

  private async getMessagePageWithClient(
    client: ImapProviderClient,
    options: MessagePageOptions,
  ): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const pageSize = options.maxResults || DEFAULT_PAGE_SIZE;
    const token = options.pageToken
      ? decodePageToken(options.pageToken)
      : undefined;
    const allMailboxes = token
      ? token.allMailboxes === true
      : options.allMailboxes === true;
    const offset = token?.offset || 0;

    if (allMailboxes) {
      return this.getMessagePageAcrossMailboxesWithClient(
        client,
        options,
        offset,
      );
    }

    const mailbox = token?.mailbox || options.mailbox || INBOX;
    const uids = await this.searchUids(client, mailbox, {
      all: true,
      from: options.from,
      text: options.query,
      before: options.before,
      since: options.after,
      seen: options.unreadOnly ? false : undefined,
    });
    const sortedUids = [...uids].sort((left, right) => right - left);
    const pageUids = sortedUids.slice(offset, offset + pageSize);
    const messages = await this.fetchMessagesByUid(client, mailbox, pageUids);
    const messagesByUid = new Map(
      messages.map((message) => [parseImapMessageId(message.id).uid, message]),
    );

    return {
      messages: pageUids
        .map((uid) => messagesByUid.get(uid))
        .filter((message): message is ParsedMessage => Boolean(message)),
      nextPageToken:
        offset + pageSize < sortedUids.length
          ? encodePageToken({ mailbox, offset: offset + pageSize })
          : undefined,
    };
  }

  private async getMessagePageAcrossMailboxesWithClient(
    client: ImapProviderClient,
    options: MessagePageOptions,
    offset: number,
  ): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const pageSize = options.maxResults || DEFAULT_PAGE_SIZE;
    const folders = (await client.list()).filter(isSelectableFolder);
    const messages: ParsedMessage[] = [];

    for (const folder of folders) {
      const uids = await this.searchUids(client, folder.path, {
        all: true,
        from: options.from,
        text: options.query,
        before: options.before,
        since: options.after,
        seen: options.unreadOnly ? false : undefined,
      });
      messages.push(
        ...(await this.fetchMessagesByUid(client, folder.path, uids)),
      );
    }

    const sortedMessages = messages.sort(
      (left, right) => getMessageTimestamp(right) - getMessageTimestamp(left),
    );
    const pageMessages = sortedMessages.slice(offset, offset + pageSize);

    return {
      messages: pageMessages,
      nextPageToken:
        offset + pageSize < sortedMessages.length
          ? encodePageToken({ allMailboxes: true, offset: offset + pageSize })
          : undefined,
    };
  }

  private async getThreadMessagesWithClient(
    client: ImapProviderClient,
    threadId: string,
  ) {
    const folders = (await client.list()).filter(isSelectableFolder);
    return this.getThreadMessagesFromMailboxes(
      client,
      threadId,
      folders.map((folder) => folder.path),
    );
  }

  private async archiveThreadMessages(threadId: string) {
    await this.withClient(async (client) => {
      const archiveMailbox = await this.findArchiveMailbox(client);
      const messages = await this.getThreadMessagesWithClient(client, threadId);
      await this.moveMessages(
        client,
        messages.map(({ id }) => parseImapMessageId(id)),
        archiveMailbox,
      );
    });
  }

  private async moveMessages(
    client: ImapProviderClient,
    messages: Array<{ mailbox: string; uid: number }>,
    destination: string,
  ) {
    const messagesByMailbox = groupMessageUidsByMailbox(
      messages.filter((message) => message.mailbox !== destination),
    );

    for (const [mailbox, uids] of messagesByMailbox) {
      await this.withMailbox(
        client,
        mailbox,
        async () => {
          const result = await client.messageMove(uids, destination, {
            uid: true,
          });
          if (result === false) {
            throw new Error(
              `IMAP move failed from ${mailbox} to ${destination}.`,
            );
          }
        },
        { readOnly: false },
      );
    }
  }

  private async updateMessageFlag(
    client: ImapProviderClient,
    messages: Array<{ mailbox: string; uid: number } | ParsedMessage>,
    flag: string,
    enabled: boolean,
  ) {
    const parsedMessages = messages.map((message) =>
      "uid" in message ? message : parseImapMessageId(message.id),
    );
    const messagesByMailbox = groupMessageUidsByMailbox(parsedMessages);

    for (const [mailbox, uids] of messagesByMailbox) {
      await this.withMailbox(
        client,
        mailbox,
        async () => {
          const result = enabled
            ? await client.messageFlagsAdd(uids, [flag], { uid: true })
            : await client.messageFlagsRemove(uids, [flag], { uid: true });
          if (result === false) {
            throw new Error(`IMAP flag update failed for ${mailbox}.`);
          }
        },
        { readOnly: false },
      );
    }
  }

  private async getThreadMessagesFromMailboxes(
    client: ImapProviderClient,
    threadId: string,
    mailboxes: string[],
  ) {
    const normalizedThreadId = normalizeMessageId(threadId) || threadId;
    const messages: ParsedMessage[] = [];

    for (const mailbox of mailboxes) {
      const uids = await this.searchUids(client, mailbox, {
        or: [
          { header: { "message-id": `<${normalizedThreadId}>` } },
          { header: { references: normalizedThreadId } },
          { header: { "in-reply-to": `<${normalizedThreadId}>` } },
        ],
      });
      messages.push(...(await this.fetchMessagesByUid(client, mailbox, uids)));
    }

    return messages
      .filter((message) => message.threadId === normalizedThreadId)
      .sort(sortMessagesOldestFirst);
  }

  private async searchUids(
    client: ImapProviderClient,
    mailbox: string,
    query: ImapSearchQuery,
  ) {
    return this.withMailbox(client, mailbox, async () => {
      const result = await client.search(removeUndefined(query), { uid: true });
      return result || [];
    });
  }

  private async fetchMessage(
    client: ImapProviderClient,
    mailbox: string,
    uid: number,
  ) {
    const raw = await this.fetchRawMessage(client, mailbox, uid);
    return parseImapMessage(raw);
  }

  private async fetchMessagesByUid(
    client: ImapProviderClient,
    mailbox: string,
    uids: number[],
  ) {
    if (!uids.length) return [];

    return this.withMailbox(client, mailbox, async () => {
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

  private async fetchRawMessage(
    client: ImapProviderClient,
    mailbox: string,
    uid: number,
  ) {
    return this.withMailbox(client, mailbox, async () => {
      const message = client.fetchOne
        ? await client.fetchOne(
            uid,
            {
              uid: true,
              flags: true,
              internalDate: true,
              size: true,
              source: true,
            },
            { uid: true },
          )
        : await firstAsync(
            client.fetch(
              [uid],
              {
                uid: true,
                flags: true,
                internalDate: true,
                size: true,
                source: true,
              },
              { uid: true },
            ),
          );

      if (!message?.source) {
        throw new Error(
          `IMAP message not found: ${formatImapMessageId(mailbox, uid)}`,
        );
      }

      return {
        id: formatImapMessageId(mailbox, message.uid),
        mailbox,
        uid: message.uid,
        source: message.source,
        flags: message.flags,
        internalDate: message.internalDate,
        size: message.size,
      };
    });
  }

  private async findSentMailbox(client: ImapProviderClient) {
    const folders = await client.list();
    return (
      folders.find((folder) => folder.specialUse === SENT_SPECIAL_USE)?.path ||
      folders.find((folder) => folder.path.toLowerCase() === "sent")?.path ||
      folders.find((folder) => folder.path.toLowerCase().includes("sent"))
        ?.path ||
      "Sent"
    );
  }

  private async findArchiveMailbox(client: ImapProviderClient) {
    return findMailboxBySpecialUseOrName(
      await client.list(),
      ARCHIVE_SPECIAL_USE,
      ARCHIVE_FOLDER_NAMES,
      "Archive",
    );
  }

  private async findTrashMailbox(client: ImapProviderClient) {
    return findMailboxBySpecialUseOrName(
      await client.list(),
      TRASH_SPECIAL_USE,
      TRASH_FOLDER_NAMES,
      "Trash",
    );
  }

  private async findDraftsMailbox(client: ImapProviderClient) {
    return findMailboxBySpecialUseOrName(
      await client.list(),
      DRAFTS_SPECIAL_USE,
      DRAFT_FOLDER_NAMES,
      "Drafts",
    );
  }

  private async withMailbox<T>(
    client: ImapProviderClient,
    mailbox: string,
    fn: () => Promise<T>,
    options: { readOnly?: boolean } = {},
  ) {
    const readOnly = options.readOnly ?? true;
    const lock = client.getMailboxLock
      ? await client.getMailboxLock(mailbox, { readOnly })
      : undefined;

    if (!lock) await client.mailboxOpen?.(mailbox, { readOnly });

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

  private async withClient<T>(fn: (client: ImapProviderClient) => Promise<T>) {
    const client = this.createClient({
      host: this.settings.imap.host,
      port: this.settings.imap.port,
      secure: this.settings.imap.secure,
      auth: {
        user: this.settings.username,
        pass: this.settings.password,
      },
      logger: false,
      connectionTimeout: this.settings.timeoutMs,
      greetingTimeout: this.settings.timeoutMs,
      socketTimeout: this.settings.timeoutMs,
    });

    await client.connect();
    try {
      return await fn(client);
    } catch (error) {
      this.logger.error("IMAP provider operation failed", { error });
      throw error;
    } finally {
      if (client.logout) {
        await client.logout().catch(() => client.close());
      } else {
        client.close();
      }
    }
  }

  private unsupported(method: string): never {
    throw new Error(
      `IMAP provider does not support ${method}: this provider is read-only.`,
    );
  }
}

function createDefaultClient(options: ImapFlowOptions): ImapProviderClient {
  return new ImapFlow(options);
}

function isSelectableFolder(folder: ImapMailbox) {
  return !Array.from(folder.flags || []).some((flag) =>
    NON_SELECTABLE_FOLDER_FLAGS.has(flag.toLowerCase()),
  );
}

function findFolderByPathOrName(folders: ImapMailbox[], folderName: string) {
  const normalizedFolderName = folderName.trim().toLowerCase();
  return folders
    .filter(isSelectableFolder)
    .find((folder) =>
      getMailboxNames(folder).some((name) => name === normalizedFolderName),
    );
}

function findMailboxBySpecialUseOrName(
  folders: ImapMailbox[],
  specialUse: string,
  folderNames: string[],
  description: string,
) {
  const selectableFolders = folders.filter(isSelectableFolder);
  const specialUseFolder = selectableFolders.find((folder) =>
    hasSpecialUse(folder, specialUse),
  );
  if (specialUseFolder) return specialUseFolder.path;

  const folderNamesSet = new Set(folderNames);
  const namedFolder = selectableFolders.find((folder) =>
    getMailboxNames(folder).some((name) => folderNamesSet.has(name)),
  );
  if (namedFolder) return namedFolder.path;

  throw new Error(`IMAP ${description} folder not found.`);
}

function hasSpecialUse(folder: ImapMailbox, specialUse: string) {
  const normalizedSpecialUse = specialUse.toLowerCase();
  return (
    folder.specialUse?.toLowerCase() === normalizedSpecialUse ||
    Array.from(folder.flags || []).some(
      (flag) => flag.toLowerCase() === normalizedSpecialUse,
    )
  );
}

function getMailboxNames(folder: ImapMailbox) {
  return [
    folder.path,
    folder.name || "",
    getFolderDisplayName(folder.path, folder.delimiter),
  ]
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

function groupMessageUidsByMailbox(
  messages: Array<{ mailbox: string; uid: number }>,
) {
  const messagesByMailbox = new Map<string, number[]>();

  for (const { mailbox, uid } of messages) {
    messagesByMailbox.set(mailbox, [
      ...(messagesByMailbox.get(mailbox) || []),
      uid,
    ]);
  }

  return messagesByMailbox;
}

function toFolderTree(folders: ImapMailbox[]): OutlookFolder[] {
  const nodes = new Map<string, OutlookFolder>();
  const roots: OutlookFolder[] = [];

  for (const folder of folders) {
    nodes.set(folder.path, {
      id: folder.path,
      displayName:
        folder.name || getFolderDisplayName(folder.path, folder.delimiter),
      childFolders: [],
      childFolderCount: 0,
    });
  }

  for (const folder of folders) {
    const node = nodes.get(folder.path)!;
    const parentPath =
      folder.parentPath || getParentPath(folder.path, folder.delimiter);
    const parent = parentPath ? nodes.get(parentPath) : undefined;
    if (parent) {
      parent.childFolders.push(node);
      parent.childFolderCount = parent.childFolders.length;
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function buildThreads(messages: ParsedMessage[]): EmailThread[] {
  const groups = new Map<string, ParsedMessage[]>();

  for (const message of messages) {
    const threadId =
      getThreadIdFromHeaders(message.headers) || message.threadId;
    message.threadId = threadId;
    groups.set(threadId, [...(groups.get(threadId) || []), message]);
  }

  return Array.from(groups.entries())
    .map(([id, threadMessages]) => {
      const sortedMessages = threadMessages.sort(sortMessagesOldestFirst);
      return {
        id,
        messages: sortedMessages,
        snippet: sortedMessages[0]?.snippet || "",
      };
    })
    .sort((left, right) => {
      const leftLatest = left.messages.at(-1);
      const rightLatest = right.messages.at(-1);
      if (!leftLatest || !rightLatest) return 0;
      return getMessageTimestamp(rightLatest) - getMessageTimestamp(leftLatest);
    });
}

function sortMessagesOldestFirst(left: ParsedMessage, right: ParsedMessage) {
  return getMessageTimestamp(left) - getMessageTimestamp(right);
}

function formatImapMessageId(mailbox: string, uid: number) {
  return `${encodeURIComponent(mailbox)}:${uid}`;
}

function createImapDraftId() {
  return `iz-draft-${randomUUID()}@inbox-zero.local`;
}

async function createDraftSource(options: {
  draftId: string;
  to: string;
  from?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  messageHtml: string;
  messageText?: string;
  attachments?: MailAttachment[];
  replyToEmail?: { headerMessageId: string; references?: string };
  inReplyTo?: string;
  references?: string;
}) {
  const threadingHeaders = options.replyToEmail
    ? buildThreadingHeaders(options.replyToEmail)
    : {
        inReplyTo: options.inReplyTo || "",
        references: options.references || "",
      };
  const mailOptions: Mail.Options = {
    from: options.from,
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    replyTo: options.replyTo,
    subject: options.subject,
    text:
      options.messageText ||
      convertEmailHtmlToText({ htmlText: options.messageHtml }),
    html: options.messageHtml,
    attachments: options.attachments,
    messageId: options.draftId,
    inReplyTo: threadingHeaders.inReplyTo || undefined,
    references: threadingHeaders.references || undefined,
    headers: {
      [IMAP_DRAFT_ID_HEADER]: options.draftId,
      "X-Mailer": "Inbox Zero Web",
    },
  };

  return new MailComposer(mailOptions).compile().build();
}

function getDraftIdFromSource(
  messageId: string,
  headerMessageId: string | undefined,
) {
  return headerMessageId || messageId;
}

function removeReferenceId(references: string | undefined, messageId: string) {
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!references || !normalizedMessageId) return references;

  return references
    .split(/\s+/)
    .map((reference) => reference.trim())
    .filter(Boolean)
    .filter(
      (reference) => normalizeMessageId(reference) !== normalizedMessageId,
    )
    .join(" ");
}

function convertTextToHtml(text: string) {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseImapMessageId(messageId: string) {
  const encodedMatch = messageId.match(/^(.*):(\d+)$/);
  if (!encodedMatch) {
    throw new Error(`Invalid IMAP message id: ${messageId}`);
  }
  return {
    mailbox: decodeURIComponent(encodedMatch[1]),
    uid: Number(encodedMatch[2]),
  };
}

function getImapMessageKey(mailbox: string, uid: number) {
  return `${mailbox}:${uid}`;
}

function encodePageToken(token: PageToken) {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

function decodePageToken(pageToken: string): PageToken {
  try {
    const decoded = JSON.parse(
      Buffer.from(pageToken, "base64url").toString("utf8"),
    );
    if (typeof decoded.offset !== "number") {
      throw new Error("invalid shape");
    }
    if (decoded.allMailboxes === true) {
      return { allMailboxes: true, offset: decoded.offset };
    }
    if (typeof decoded.mailbox !== "string") {
      throw new Error("invalid shape");
    }
    return { mailbox: decoded.mailbox, offset: decoded.offset };
  } catch {
    throw new Error("Invalid IMAP page token.");
  }
}

function normalizeFolderPath(folderName: string) {
  const folderPath = folderName.trim();
  if (!folderPath) throw new Error("IMAP folder name is required.");
  if (/\p{C}/u.test(folderPath)) {
    throw new Error("IMAP folder name contains unsupported characters.");
  }
  return folderPath;
}

function getFolderDisplayName(path: string, delimiter = "/") {
  return path.split(delimiter).at(-1) || path;
}

function getParentPath(path: string, delimiter = "/") {
  const parts = path.split(delimiter);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join(delimiter);
}

async function firstAsync<T>(iterable: AsyncIterable<T>) {
  for await (const item of iterable) return item;
  return;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
