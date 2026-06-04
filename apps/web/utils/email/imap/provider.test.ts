import { describe, expect, it, vi } from "vitest";
import { STRATO_IMAP_PRESET } from "@/utils/email/imap-presets";
import { ImapProvider, type ImapProviderClient } from "./provider";

vi.mock("server-only", () => ({}));

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

  it("throws clear errors for unsupported read-only operations", async () => {
    const provider = new ImapProvider(settings, undefined, {
      createClient: () => new MockImapClient(),
    });

    await expect(
      provider.sendEmail({
        to: "to@example.com",
        subject: "Nope",
        messageText: "Body",
      }),
    ).rejects.toThrow(
      "IMAP provider does not support sendEmail: this provider is read-only.",
    );
  });
});

class MockImapClient implements ImapProviderClient {
  connect = vi.fn(async () => undefined);
  close = vi.fn();
  logout = vi.fn(async () => undefined);
  private currentMailbox = "INBOX";
  private readonly folders: Array<{
    path: string;
    name?: string;
    delimiter?: string;
    parentPath?: string;
    specialUse?: string;
    status?: { messages?: number; unseen?: number };
  }>;
  private readonly messages: Record<string, StoredMessage[]>;

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

  async status(path: string) {
    const messages = this.messages[path] || [];
    return {
      messages: messages.length,
      unseen: messages.filter((message) => !message.flags?.has("\\Seen"))
        .length,
    };
  }

  async mailboxOpen(path: string) {
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
}

function buildStoredMessage(
  uid: number,
  messageId: string,
  subject: string,
  date: string,
  headers: { references?: string; inReplyTo?: string } = {},
): StoredMessage {
  return {
    uid,
    internalDate: new Date(date),
    flags: new Set(["\\Seen"]),
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
