import { describe, expect, it, vi } from "vitest";
import { STRATO_IMAP_PRESET } from "@/utils/email/imap-presets";
import { ImapProvider, type ImapProviderClient } from "./provider";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_EMAIL_SEND_ENABLED: true,
    NEXT_PUBLIC_AUTO_DRAFT_DISABLED: false,
    NODE_ENV: "test",
  },
}));

type StoredMessage = {
  uid: number;
  source: Buffer;
  flags?: Set<string>;
  internalDate?: Date;
};

const settings = {
  imap: STRATO_IMAP_PRESET.imap,
  smtp: STRATO_IMAP_PRESET.smtp,
  username: "user@example.com",
  password: "password",
};

describe("ImapProvider", () => {
  it("maps IMAP folders to folder and label shapes", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        { path: "Projects", name: "Projects", delimiter: "/" },
        {
          path: "Projects/Alpha",
          name: "Alpha",
          delimiter: "/",
          parentPath: "Projects",
        },
      ],
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    await expect(provider.getFolders()).resolves.toEqual([
      {
        id: "INBOX",
        displayName: "INBOX",
        childFolders: [],
        childFolderCount: 0,
      },
      {
        id: "Projects",
        displayName: "Projects",
        childFolders: [
          {
            id: "Projects/Alpha",
            displayName: "Alpha",
            childFolders: [],
            childFolderCount: 0,
          },
        ],
        childFolderCount: 1,
      },
    ]);

    await expect(provider.getLabels()).resolves.toEqual([
      expect.objectContaining({ id: "INBOX", name: "INBOX", type: "folder" }),
      expect.objectContaining({
        id: "Projects",
        name: "Projects",
        type: "folder",
      }),
      expect.objectContaining({
        id: "Projects/Alpha",
        name: "Alpha",
        type: "folder",
      }),
    ]);
  });

  it("returns newest-first paginated inbox messages with opaque page tokens", async () => {
    const client = new MockImapClient({
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "first@example.com",
            "First",
            "2030-01-01T09:00:00.000Z",
          ),
          buildStoredMessage(
            2,
            "second@example.com",
            "Second",
            "2030-01-01T10:00:00.000Z",
          ),
          buildStoredMessage(
            3,
            "third@example.com",
            "Third",
            "2030-01-01T11:00:00.000Z",
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    const firstPage = await provider.getMessagesWithPagination({
      maxResults: 2,
    });

    expect(firstPage.messages.map((message) => message.id)).toEqual([
      "INBOX:3",
      "INBOX:2",
    ]);
    expect(firstPage.nextPageToken).toBeTruthy();

    const secondPage = await provider.getMessagesWithPagination({
      maxResults: 2,
      pageToken: firstPage.nextPageToken,
    });

    expect(secondPage.messages.map((message) => message.id)).toEqual([
      "INBOX:1",
    ]);
    expect(secondPage.nextPageToken).toBeUndefined();
  });

  it("returns all-folder paginated messages when inboxOnly is false", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        { path: "Archive", name: "Archive", delimiter: "/" },
      ],
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "inbox@example.com",
            "Inbox",
            "2030-01-01T09:00:00.000Z",
          ),
        ],
        Archive: [
          buildStoredMessage(
            2,
            "archive@example.com",
            "Archive",
            "2030-01-01T10:00:00.000Z",
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    const firstPage = await provider.getMessagesWithPagination({
      maxResults: 1,
      inboxOnly: false,
    });

    expect(firstPage.messages.map((message) => message.id)).toEqual([
      "Archive:2",
    ]);
    expect(firstPage.messages.map((message) => message.parentFolderId)).toEqual(
      ["Archive"],
    );
    expect(firstPage.nextPageToken).toBeTruthy();

    const secondPage = await provider.getMessagesWithPagination({
      maxResults: 1,
      inboxOnly: false,
      pageToken: firstPage.nextPageToken,
    });

    expect(secondPage.messages.map((message) => message.id)).toEqual([
      "INBOX:1",
    ]);
    expect(secondPage.nextPageToken).toBeUndefined();
  });

  it("skips non-selectable folders during all-folder pagination", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        {
          path: "[Gmail]",
          name: "[Gmail]",
          delimiter: "/",
          flags: new Set(["\\Noselect"]),
        },
        {
          path: "Archive",
          name: "Archive",
          delimiter: "/",
          flags: new Set(["\\NonExistent"]),
        },
        { path: "Selectable", name: "Selectable", delimiter: "/" },
      ],
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "inbox@example.com",
            "Inbox",
            "2030-01-01T09:00:00.000Z",
          ),
        ],
        "[Gmail]": [
          buildStoredMessage(
            2,
            "noselect@example.com",
            "Noselect",
            "2030-01-01T12:00:00.000Z",
          ),
        ],
        Archive: [
          buildStoredMessage(
            3,
            "nonexistent@example.com",
            "NonExistent",
            "2030-01-01T11:00:00.000Z",
          ),
        ],
        Selectable: [
          buildStoredMessage(
            4,
            "selectable@example.com",
            "Selectable",
            "2030-01-01T10:00:00.000Z",
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    const page = await provider.getMessagesWithPagination({
      maxResults: 10,
      inboxOnly: false,
    });

    expect(page.messages.map((message) => message.id)).toEqual([
      "Selectable:4",
      "INBOX:1",
    ]);
    expect(client.openedMailboxes).not.toContain("[Gmail]");
    expect(client.openedMailboxes).not.toContain("Archive");
  });

  it("skips non-selectable folders during Message-ID lookup", async () => {
    const client = new MockImapClient({
      folders: [
        {
          path: "[Gmail]",
          name: "[Gmail]",
          delimiter: "/",
          flags: new Set(["\\Noselect"]),
        },
        { path: "Archive", name: "Archive", delimiter: "/" },
      ],
      messages: {
        "[Gmail]": [
          buildStoredMessage(
            1,
            "target@example.com",
            "Skipped",
            "2030-01-01T09:00:00.000Z",
          ),
        ],
        Archive: [
          buildStoredMessage(
            2,
            "target@example.com",
            "Target",
            "2030-01-01T10:00:00.000Z",
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    const message =
      await provider.getMessageByRfc822MessageId("target@example.com");

    expect(message?.id).toBe("Archive:2");
    expect(client.openedMailboxes).not.toContain("[Gmail]");
  });

  it("uses the IMAP sent special-use folder for sent message listing", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        {
          path: "Sent Mail",
          name: "Sent Mail",
          delimiter: "/",
          specialUse: "\\Sent",
        },
      ],
      messages: {
        "Sent Mail": [
          buildStoredMessage(
            7,
            "sent@example.com",
            "Sent",
            "2030-01-02T10:00:00.000Z",
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    const messages = await provider.getSentMessages();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "Sent%20Mail:7",
      parentFolderId: "Sent Mail",
      subject: "Sent",
    });
  });

  it("reconstructs local threads from Message-ID, References, and In-Reply-To", async () => {
    const client = new MockImapClient({
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "root@example.com",
            "Root",
            "2030-01-01T09:00:00.000Z",
          ),
          buildStoredMessage(
            2,
            "reply@example.com",
            "Re: Root",
            "2030-01-01T10:00:00.000Z",
            {
              references: "<root@example.com>",
              inReplyTo: "<root@example.com>",
            },
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    const threads = await provider.getThreads();

    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("root@example.com");
    expect(threads[0].messages.map((message) => message.subject)).toEqual([
      "Root",
      "Re: Root",
    ]);
  });

  it("fetches full thread messages across folders and filters inbox thread messages", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        { path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent" },
        {
          path: "Labels",
          name: "Labels",
          delimiter: "/",
          flags: new Set(["\\Noselect"]),
        },
      ],
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "root@example.com",
            "Root",
            "2030-01-01T09:00:00.000Z",
          ),
        ],
        Sent: [
          buildStoredMessage(
            2,
            "reply@example.com",
            "Re: Root",
            "2030-01-01T10:00:00.000Z",
            {
              references: "<root@example.com>",
              inReplyTo: "<root@example.com>",
            },
          ),
        ],
        Labels: [
          buildStoredMessage(
            3,
            "label@example.com",
            "Skipped",
            "2030-01-01T11:00:00.000Z",
            {
              references: "<root@example.com>",
              inReplyTo: "<root@example.com>",
            },
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    const allMessages = await provider.getThreadMessages("root@example.com");
    const inboxMessages =
      await provider.getThreadMessagesInInbox("root@example.com");

    expect(allMessages.map((message) => message.id)).toEqual([
      "INBOX:1",
      "Sent:2",
    ]);
    expect(inboxMessages.map((message) => message.id)).toEqual(["INBOX:1"]);
    expect(client.openedMailboxes).not.toContain("Labels");
  });

  it("archives a single message to the common-name archive folder", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        { path: "Archiv", name: "Archiv", delimiter: "/" },
      ],
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "root@example.com",
            "Root",
            "2030-01-01T09:00:00.000Z",
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    await provider.archiveMessage("INBOX:1");

    expect(client.messages.INBOX).toEqual([]);
    expect(client.messages.Archiv?.map((message) => message.uid)).toEqual([1]);
    expect(client.openedMailboxOptions).toContainEqual({
      path: "INBOX",
      readOnly: false,
    });
  });

  it("archives every thread message to the special-use archive folder and ignores label arguments", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        { path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent" },
        {
          path: "Archive Mail",
          name: "Archive Mail",
          delimiter: "/",
          specialUse: "\\Archive",
        },
      ],
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "root@example.com",
            "Root",
            "2030-01-01T09:00:00.000Z",
          ),
        ],
        Sent: [
          buildStoredMessage(
            2,
            "reply@example.com",
            "Re: Root",
            "2030-01-01T10:00:00.000Z",
            {
              references: "<root@example.com>",
              inReplyTo: "<root@example.com>",
            },
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    await provider.archiveThreadWithLabel(
      "root@example.com",
      "user@example.com",
      "ignored-label",
    );

    expect(client.messages.INBOX).toEqual([]);
    expect(client.messages.Sent).toEqual([]);
    expect(
      client.messages["Archive Mail"]?.map((message) => message.uid),
    ).toEqual([1, 2]);
  });

  it("finds existing folder IDs by folder name or path", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        { path: "Projects/Alpha", name: "Alpha", delimiter: "/" },
      ],
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    await expect(provider.getOrCreateFolderIdByName("Alpha")).resolves.toBe(
      "Projects/Alpha",
    );
    await expect(
      provider.getOrCreateFolderIdByName("Projects/Alpha"),
    ).resolves.toBe("Projects/Alpha");
    expect(client.createdMailboxes).toEqual([]);
  });

  it("creates missing folders and returns the folder path as the ID", async () => {
    const client = new MockImapClient();
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    await expect(
      provider.getOrCreateFolderIdByName("Newsletter"),
    ).resolves.toBe("Newsletter");

    expect(client.createdMailboxes).toEqual(["Newsletter"]);
    expect((await client.list()).map((folder) => folder.path)).toContain(
      "Newsletter",
    );
  });

  it("moves every thread message to an IMAP folder path", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        { path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent" },
        { path: "Newsletter", name: "Newsletter", delimiter: "/" },
      ],
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "root@example.com",
            "Root",
            "2030-01-01T09:00:00.000Z",
          ),
        ],
        Sent: [
          buildStoredMessage(
            2,
            "reply@example.com",
            "Re: Root",
            "2030-01-01T10:00:00.000Z",
            {
              references: "<root@example.com>",
              inReplyTo: "<root@example.com>",
            },
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    await provider.moveThreadToFolder(
      "root@example.com",
      "user@example.com",
      "Newsletter",
    );

    expect(client.messages.INBOX).toEqual([]);
    expect(client.messages.Sent).toEqual([]);
    expect(client.messages.Newsletter?.map((message) => message.uid)).toEqual([
      1, 2,
    ]);
    expect(client.openedMailboxOptions).toContainEqual({
      path: "INBOX",
      readOnly: false,
    });
  });

  it("trashes every thread message to the common-name trash folder", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        { path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent" },
        { path: "Deleted Items", name: "Deleted Items", delimiter: "/" },
      ],
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "root@example.com",
            "Root",
            "2030-01-01T09:00:00.000Z",
          ),
        ],
        Sent: [
          buildStoredMessage(
            2,
            "reply@example.com",
            "Re: Root",
            "2030-01-01T10:00:00.000Z",
            {
              references: "<root@example.com>",
              inReplyTo: "<root@example.com>",
            },
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    await provider.trashThread("root@example.com", "user@example.com", "user");

    expect(client.messages.INBOX).toEqual([]);
    expect(client.messages.Sent).toEqual([]);
    expect(
      client.messages["Deleted Items"]?.map((message) => message.uid),
    ).toEqual([1, 2]);
  });

  it("updates read and starred flags with writable mailbox access", async () => {
    const client = new MockImapClient({
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "root@example.com",
            "Root",
            "2030-01-01T09:00:00.000Z",
            {},
            new Set(),
          ),
          buildStoredMessage(
            2,
            "reply@example.com",
            "Re: Root",
            "2030-01-01T10:00:00.000Z",
            {
              references: "<root@example.com>",
              inReplyTo: "<root@example.com>",
            },
            new Set(),
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    await provider.markRead("root@example.com");

    expect(
      client.messages.INBOX?.map((message) => message.flags?.has("\\Seen")),
    ).toEqual([true, true]);

    await provider.markReadThread("root@example.com", false);
    await provider.starMessage("INBOX:1");

    expect(
      client.messages.INBOX?.map((message) => message.flags?.has("\\Seen")),
    ).toEqual([false, false]);
    expect(client.messages.INBOX?.[0]?.flags?.has("\\Flagged")).toBe(true);
    expect(client.messages.INBOX?.[1]?.flags?.has("\\Flagged")).toBe(false);
    expect(client.openedMailboxOptions).toContainEqual({
      path: "INBOX",
      readOnly: false,
    });
  });

  it("creates, reads, updates, lists, and deletes IMAP drafts in the Drafts folder with stable IDs", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        {
          path: "Drafts",
          name: "Drafts",
          delimiter: "/",
          specialUse: "\\Drafts",
        },
      ],
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "root@example.com",
            "Root",
            "2030-01-01T09:00:00.000Z",
          ),
        ],
      },
    });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
    });

    const { id: draftId } = await provider.createDraft({
      to: "recipient@example.com",
      subject: "Re: Root",
      messageHtml: "<p>Initial body</p>",
      replyToMessageId: "INBOX:1",
    });

    expect(draftId).toMatch(/^iz-draft-/);
    expect(client.messages.Drafts).toHaveLength(1);
    expect(client.messages.Drafts?.[0]?.flags?.has("\\Draft")).toBe(true);

    const initialDraft = await provider.getDraft(draftId);
    expect(initialDraft).toMatchObject({
      id: draftId,
      subject: "Re: Root",
      parentFolderId: "Drafts",
      threadId: "root@example.com",
    });
    expect(initialDraft?.headers["in-reply-to"]).toBe("root@example.com");
    expect(initialDraft?.textHtml).toContain("Initial body");

    await provider.updateDraft(draftId, {
      subject: "Re: Root updated",
      messageHtml: "<p>Updated body</p>",
    });

    const updatedDraft = await provider.getDraft(draftId);
    expect(updatedDraft).toMatchObject({
      id: draftId,
      subject: "Re: Root updated",
      threadId: "root@example.com",
    });
    expect(updatedDraft?.textHtml).toContain("Updated body");
    expect(client.messages.Drafts).toHaveLength(1);

    await expect(provider.getDrafts()).resolves.toEqual([
      expect.objectContaining({ id: draftId, subject: "Re: Root updated" }),
    ]);

    await provider.deleteDraft(draftId);

    await expect(provider.getDraft(draftId)).resolves.toBeNull();
    expect(client.messages.Drafts).toEqual([]);
  });

  it("sends IMAP drafts with SMTP threading and deletes them only after successful send", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        {
          path: "Drafts",
          name: "Drafts",
          delimiter: "/",
          specialUse: "\\Drafts",
        },
      ],
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "root@example.com",
            "Root",
            "2030-01-01T09:00:00.000Z",
          ),
        ],
      },
    });
    const sendMail = vi
      .fn()
      .mockResolvedValue({ messageId: "<sent@example.com>" });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
      createSmtpTransport: () => ({ sendMail }),
    });
    const { id: draftId } = await provider.createDraft({
      to: "recipient@example.com",
      subject: "Re: Root",
      messageHtml: "<p>Ready to send</p>",
      replyToMessageId: "INBOX:1",
    });

    await expect(provider.sendDraft(draftId)).resolves.toEqual({
      messageId: "",
      threadId: "root@example.com",
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "recipient@example.com",
        subject: "Re: Root",
        inReplyTo: "<root@example.com>",
        references: "<root@example.com>",
        headers: expect.objectContaining({ "X-Mailer": "Inbox Zero Web" }),
      }),
    );
    expect(client.messages.Drafts).toEqual([]);

    const { id: failedDraftId } = await provider.createDraft({
      to: "recipient@example.com",
      subject: "Re: Root failed",
      messageHtml: "<p>Do not delete yet</p>",
      replyToMessageId: "INBOX:1",
    });
    sendMail.mockRejectedValueOnce(new Error("SMTP down"));

    await expect(provider.sendDraft(failedDraftId)).rejects.toThrow(
      "Email could not be sent. Try again later.",
    );
    expect(client.messages.Drafts).toHaveLength(1);
    await expect(provider.getDraft(failedDraftId)).resolves.toMatchObject({
      id: failedDraftId,
      subject: "Re: Root failed",
    });
  });

  it("sends stored IMAP draft attachments through SMTP", async () => {
    const client = new MockImapClient({
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        {
          path: "Drafts",
          name: "Drafts",
          delimiter: "/",
          specialUse: "\\Drafts",
        },
      ],
      messages: {
        INBOX: [
          buildStoredMessage(
            1,
            "root@example.com",
            "Root",
            "2030-01-01T09:00:00.000Z",
          ),
        ],
      },
    });
    const sendMail = vi
      .fn()
      .mockResolvedValue({ messageId: "<sent@example.com>" });
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => client,
      createSmtpTransport: () => ({ sendMail }),
    });

    const originalMessage = await provider.getMessage("INBOX:1");
    const { draftId } = await provider.draftEmail(
      originalMessage,
      {
        content: "Draft with attachment",
        attachments: [
          {
            filename: "report.csv",
            content: Buffer.from("a,b,c"),
            contentType: "text/csv",
          },
        ],
      },
      settings.username,
    );

    await provider.sendDraft(draftId);

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            filename: "report.csv",
            contentType: "text/csv",
            content: Buffer.from("a,b,c"),
          }),
        ],
      }),
    );
    expect(client.messages.Drafts).toEqual([]);
  });
});

class MockImapClient implements ImapProviderClient {
  connect = vi.fn(async () => undefined);
  close = vi.fn();
  logout = vi.fn(async () => undefined);
  openedMailboxes: string[] = [];
  openedMailboxOptions: Array<{ path: string; readOnly?: boolean }> = [];
  createdMailboxes: string[] = [];
  private currentMailbox = "INBOX";
  private readonly folders: Array<{
    path: string;
    name?: string;
    delimiter?: string;
    parentPath?: string;
    specialUse?: string;
    flags?: Set<string>;
    status?: { messages?: number; unseen?: number };
  }>;
  readonly messages: Record<string, StoredMessage[]>;

  constructor(
    options: {
      folders?: MockImapClient["folders"];
      messages?: Record<string, StoredMessage[]>;
    } = {},
  ) {
    this.messages = options.messages || {};
    this.folders = options.folders || [
      { path: "INBOX", name: "INBOX", delimiter: "/" },
      { path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent" },
    ];
  }

  async list() {
    return this.folders;
  }

  async mailboxCreate(path: string) {
    this.createdMailboxes.push(path);
    if (!this.folders.some((folder) => folder.path === path)) {
      this.folders.push({
        path,
        name: path.split("/").at(-1),
        delimiter: "/",
      });
    }
    this.messages[path] ||= [];
    return true;
  }

  async status(path: string) {
    const messages = this.messages[path] || [];
    return {
      messages: messages.length,
      unseen: messages.filter((message) => !message.flags?.has("\\Seen"))
        .length,
    };
  }

  async mailboxOpen(path: string, options?: { readOnly?: boolean }) {
    const folder = this.folders.find((item) => item.path === path);
    if (
      Array.from(folder?.flags || []).some((flag) =>
        ["\\noselect", "\\nonexistent"].includes(flag.toLowerCase()),
      )
    ) {
      throw new Error(`Cannot open non-selectable mailbox: ${path}`);
    }
    this.openedMailboxes.push(path);
    this.openedMailboxOptions.push({ path, readOnly: options?.readOnly });
    this.currentMailbox = path;
  }

  async mailboxClose() {
    return true;
  }

  async search(query: {
    all?: boolean;
    from?: string;
    text?: string;
    before?: Date;
    since?: Date;
    seen?: boolean;
    header?: Record<string, string | boolean>;
    or?: Array<{ header?: Record<string, string | boolean> }>;
  }) {
    return (this.messages[this.currentMailbox] || [])
      .filter((message) => matchesQuery(message, query))
      .map((message) => message.uid);
  }

  async *fetch(range: number[]) {
    for (const uid of range) {
      const message = (this.messages[this.currentMailbox] || []).find(
        (item) => item.uid === uid,
      );
      if (!message) continue;
      yield {
        uid: message.uid,
        source: message.source,
        flags: message.flags,
        internalDate: message.internalDate,
        size: message.source.length,
      };
    }
  }

  async fetchOne(uid: number) {
    const message = (this.messages[this.currentMailbox] || []).find(
      (item) => item.uid === uid,
    );
    if (!message) return false as const;
    return {
      uid: message.uid,
      source: message.source,
      flags: message.flags,
      internalDate: message.internalDate,
      size: message.source.length,
    };
  }

  async messageMove(range: number[], destination: string) {
    const sourceMessages = this.messages[this.currentMailbox] || [];
    const uidSet = new Set(range);
    const movingMessages = sourceMessages.filter((message) =>
      uidSet.has(message.uid),
    );

    this.messages[this.currentMailbox] = sourceMessages.filter(
      (message) => !uidSet.has(message.uid),
    );
    this.messages[destination] = [
      ...(this.messages[destination] || []),
      ...movingMessages,
    ];

    return true;
  }

  async messageDelete(range: number[]) {
    const uidSet = new Set(range);
    this.messages[this.currentMailbox] = (
      this.messages[this.currentMailbox] || []
    ).filter((message) => !uidSet.has(message.uid));
    return true;
  }

  async append(path: string, content: string | Buffer, flags: string[] = []) {
    const messages = this.messages[path] || [];
    this.messages[path] = messages;
    const uid = Math.max(0, ...messages.map((message) => message.uid)) + 1;
    messages.push({
      uid,
      source: Buffer.isBuffer(content) ? content : Buffer.from(content),
      flags: new Set(flags),
      internalDate: new Date(),
    });
    return { destination: path, uid };
  }

  async messageFlagsAdd(range: number[], flags: string[]) {
    this.updateFlags(range, flags, true);
    return true;
  }

  async messageFlagsRemove(range: number[], flags: string[]) {
    this.updateFlags(range, flags, false);
    return true;
  }

  private updateFlags(range: number[], flags: string[], enabled: boolean) {
    const uidSet = new Set(range);
    for (const message of this.messages[this.currentMailbox] || []) {
      if (!uidSet.has(message.uid)) continue;
      message.flags ||= new Set();
      for (const flag of flags) {
        if (enabled) {
          message.flags.add(flag);
        } else {
          message.flags.delete(flag);
        }
      }
    }
  }
}

function buildStoredMessage(
  uid: number,
  messageId: string,
  subject: string,
  date: string,
  headers: { references?: string; inReplyTo?: string } = {},
  flags = new Set(["\\Seen"]),
): StoredMessage {
  return {
    uid,
    internalDate: new Date(date),
    flags,
    source: Buffer.from(`From: Sender <sender@example.com>
To: Recipient <recipient@example.com>
Subject: ${subject}
Message-ID: <${messageId}>
${headers.references ? `References: ${headers.references}\n` : ""}${headers.inReplyTo ? `In-Reply-To: ${headers.inReplyTo}\n` : ""}Date: ${new Date(date).toUTCString()}
Content-Type: text/plain; charset=utf-8

${subject} body`),
  };
}

function matchesQuery(
  message: StoredMessage,
  query: {
    all?: boolean;
    from?: string;
    text?: string;
    before?: Date;
    since?: Date;
    seen?: boolean;
    header?: Record<string, string | boolean>;
    or?: Array<{ header?: Record<string, string | boolean> }>;
  },
) {
  const raw = message.source.toString();
  if (query.seen !== undefined && message.flags?.has("\\Seen") !== query.seen) {
    return false;
  }
  if (
    query.before &&
    !(message.internalDate && message.internalDate < query.before)
  ) {
    return false;
  }
  if (
    query.since &&
    !(message.internalDate && message.internalDate >= query.since)
  ) {
    return false;
  }
  if (query.from && !raw.toLowerCase().includes(query.from.toLowerCase())) {
    return false;
  }
  if (query.text && !raw.toLowerCase().includes(query.text.toLowerCase())) {
    return false;
  }
  if (query.or) {
    return query.or.some((item) => matchesHeaders(raw, item.header || {}));
  }
  return matchesHeaders(raw, query.header || {});
}

function matchesHeaders(
  raw: string,
  headers: Record<string, string | boolean>,
) {
  return Object.entries(headers).every(([key, expected]) => {
    if (expected === true)
      return raw.toLowerCase().includes(`${key.toLowerCase()}:`);
    return raw.toLowerCase().includes(String(expected).toLowerCase());
  });
}
