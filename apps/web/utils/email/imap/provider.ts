import "server-only";

import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type { Attachment as MailAttachment } from "nodemailer/lib/mailer";
import type { InboxZeroLabel } from "@/utils/label";
import type { ThreadsQuery } from "@/utils/threads/validation";
import type { OutlookFolder } from "@/utils/outlook/folders";
import type { ParsedMessage } from "@/utils/types";
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
import {
  getThreadIdFromHeaders,
  normalizeMessageId,
  parseImapAttachment,
  parseImapMessage,
} from "@/utils/email/imap/message-parser";
import { createScopedLogger, type Logger } from "@/utils/logger";

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_THREAD_SCAN_LIMIT = 100;
const INBOX = "INBOX";
const SENT_SPECIAL_USE = "\\Sent";

export type ImapProviderClient = {
  connect(): Promise<void>;
  close(): void;
  logout?(): Promise<void>;
  list(options?: unknown): Promise<ImapMailbox[]>;
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
};

type ImapProviderClients = {
  createClient?: (options: ImapFlowOptions) => ImapProviderClient;
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

  constructor(
    settings: MailboxConnectionSettings,
    logger?: Logger,
    clients: ImapProviderClients = {},
  ) {
    this.settings = settings;
    this.createClient = clients.createClient ?? createDefaultClient;
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
      const folders = await client.list();
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
    return this.withClient(async (client) => {
      const folders = await client.list();
      return this.getThreadMessagesFromMailboxes(
        client,
        threadId,
        folders.map((folder) => folder.path),
      );
    });
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

  async archiveMessage(_messageId: string): Promise<void> {
    this.unsupported("archiveMessage");
  }
  async archiveThread(_threadId: string, _ownerEmail: string): Promise<void> {
    this.unsupported("archiveThread");
  }
  async archiveThreadWithLabel(
    _threadId: string,
    _ownerEmail: string,
    _labelId?: string,
  ): Promise<void> {
    this.unsupported("archiveThreadWithLabel");
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
  async createDraft(_params: {
    to: string;
    subject: string;
    messageHtml: string;
    replyToMessageId?: string;
  }): Promise<{ id: string }> {
    this.unsupported("createDraft");
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
  async deleteDraft(_draftId: string): Promise<void> {
    this.unsupported("deleteDraft");
  }
  async deleteFilter(_id: string): Promise<{ status: number }> {
    this.unsupported("deleteFilter");
  }
  async deleteLabel(_labelId: string): Promise<void> {
    this.unsupported("deleteLabel");
  }
  async draftEmail(
    _email: ParsedMessage,
    _args: {
      to?: string;
      subject?: string;
      content: string;
      cc?: string;
      bcc?: string;
      attachments?: MailAttachment[];
    },
    _userEmail: string,
    _executedRule?: { id: string; threadId: string; emailAccountId: string },
  ): Promise<{ draftId: string }> {
    this.unsupported("draftEmail");
  }
  async forwardEmail(
    _email: ParsedMessage,
    _args: {
      to: string;
      cc?: string;
      bcc?: string;
      content?: string;
      from?: string;
    },
  ): Promise<void> {
    this.unsupported("forwardEmail");
  }
  async getDraft(_draftId: string): Promise<ParsedMessage | null> {
    this.unsupported("getDraft");
  }
  async getDrafts(_options?: {
    maxResults?: number;
  }): Promise<ParsedMessage[]> {
    this.unsupported("getDrafts");
  }
  async getFiltersList(): Promise<EmailFilter[]> {
    this.unsupported("getFiltersList");
  }
  async getOrCreateFolderIdByName(_folderName: string): Promise<string> {
    this.unsupported("getOrCreateFolderIdByName");
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
  async markRead(_threadId: string): Promise<void> {
    this.unsupported("markRead");
  }
  async markReadThread(_threadId: string, _read: boolean): Promise<void> {
    this.unsupported("markReadThread");
  }
  async markSpam(_threadId: string): Promise<void> {
    this.unsupported("markSpam");
  }
  async moveThreadToFolder(
    _threadId: string,
    _ownerEmail: string,
    _folderName: string,
  ): Promise<void> {
    this.unsupported("moveThreadToFolder");
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
    _email: ParsedMessage,
    _content: string,
    _options?: {
      replyTo?: string;
      from?: string;
      attachments?: MailAttachment[];
    },
  ): Promise<void> {
    this.unsupported("replyToEmail");
  }
  async sendDraft(
    _draftId: string,
  ): Promise<{ messageId: string; threadId: string }> {
    this.unsupported("sendDraft");
  }
  async sendEmail(_args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
    attachments?: MailAttachment[];
  }): Promise<void> {
    this.unsupported("sendEmail");
  }
  async sendEmailWithHtml(_body: {
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
    this.unsupported("sendEmailWithHtml");
  }
  async starMessage(_messageId: string): Promise<void> {
    this.unsupported("starMessage");
  }
  async trashThread(
    _threadId: string,
    _ownerEmail: string,
    _actionSource: "user" | "automation",
  ): Promise<void> {
    this.unsupported("trashThread");
  }
  async unwatchEmails(_subscriptionId?: string): Promise<void> {
    this.unsupported("unwatchEmails");
  }
  async updateDraft(
    _draftId: string,
    _params: { messageHtml?: string; subject?: string },
  ): Promise<void> {
    this.unsupported("updateDraft");
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
    const folders = await client.list();
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

  private async withMailbox<T>(
    client: ImapProviderClient,
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
