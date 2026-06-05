import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@/utils/logger";
import {
  pollImapEmailAccounts,
  syncImapMailbox,
  type ImapMailboxSyncClient,
  type ImapSyncCursor,
} from "./sync";

vi.mock("server-only", () => ({}));

describe("syncImapMailbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes all mailbox messages and stores UIDVALIDITY cursor on first sync", async () => {
    const client = new MockImapClient({ uidValidity: 7, uids: [1, 2, 3] });
    const processMessage = vi.fn();
    const saveCursor = vi.fn();

    const result = await syncImapMailbox({
      emailAccountId: "email-account-id",
      mailbox: "INBOX",
      cursor: null,
      client,
      processMessage,
      saveCursor,
      logger: mockLogger(),
    });

    expect(processMessage).toHaveBeenCalledTimes(3);
    expect(processMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "INBOX:1", historyId: "1" }),
    );
    expect(processMessage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ id: "INBOX:3", historyId: "3" }),
    );
    expect(saveCursor).toHaveBeenCalledWith({
      mailboxes: {
        INBOX: {
          uidValidity: "7",
          lastUid: 3,
          syncedAt: expect.any(String),
        },
      },
    });
    expect(result).toEqual({
      emailAccountId: "email-account-id",
      mailbox: "INBOX",
      processed: 3,
      lastUid: 3,
      uidValidity: "7",
      uidValidityChanged: false,
    });
  });

  it("processes only UIDs newer than the stored cursor on incremental sync", async () => {
    const client = new MockImapClient({ uidValidity: 7, uids: [1, 2, 3, 4] });
    const processMessage = vi.fn();
    const saveCursor = vi.fn();
    const cursor: ImapSyncCursor = {
      mailboxes: {
        INBOX: {
          uidValidity: "7",
          lastUid: 2,
          syncedAt: "2030-01-01T00:00:00.000Z",
        },
      },
    };

    const result = await syncImapMailbox({
      emailAccountId: "email-account-id",
      mailbox: "INBOX",
      cursor,
      client,
      processMessage,
      saveCursor,
      logger: mockLogger(),
    });

    expect(client.fetchedRanges).toEqual([[3, 4]]);
    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(processMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "INBOX:3", historyId: "3" }),
    );
    expect(processMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "INBOX:4", historyId: "4" }),
    );
    expect(saveCursor).toHaveBeenCalledWith({
      mailboxes: {
        INBOX: {
          uidValidity: "7",
          lastUid: 4,
          syncedAt: expect.any(String),
        },
      },
    });
    expect(result.lastUid).toBe(4);
    expect(result.uidValidityChanged).toBe(false);
  });

  it("resets the UID cursor when UIDVALIDITY changes", async () => {
    const client = new MockImapClient({ uidValidity: 8, uids: [1, 2] });
    const processMessage = vi.fn();
    const saveCursor = vi.fn();
    const cursor: ImapSyncCursor = {
      mailboxes: {
        INBOX: {
          uidValidity: "7",
          lastUid: 100,
          syncedAt: "2030-01-01T00:00:00.000Z",
        },
      },
    };

    const result = await syncImapMailbox({
      emailAccountId: "email-account-id",
      mailbox: "INBOX",
      cursor,
      client,
      processMessage,
      saveCursor,
      logger: mockLogger(),
    });

    expect(client.fetchedRanges).toEqual([[1, 2]]);
    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(saveCursor).toHaveBeenCalledWith({
      mailboxes: {
        INBOX: {
          uidValidity: "8",
          lastUid: 2,
          syncedAt: expect.any(String),
        },
      },
    });
    expect(result.uidValidityChanged).toBe(true);
  });
});

describe("pollImapEmailAccounts", () => {
  it("logs polling errors without failing the whole polling batch", async () => {
    const logger = mockLogger();
    const syncAccount = vi.fn().mockRejectedValue(new Error("auth failed"));

    const results = await pollImapEmailAccounts({
      emailAccountIds: ["email-account-id"],
      logger,
      syncAccount,
    });

    expect(logger.error).toHaveBeenCalledWith("Error polling IMAP account", {
      emailAccountId: "email-account-id",
      error: expect.any(Error),
    });
    expect(results).toEqual([
      {
        emailAccountId: "email-account-id",
        status: "error",
        message: "Failed to poll IMAP account.",
        errorDetails: "auth failed",
      },
    ]);
  });
});

class MockImapClient implements ImapMailboxSyncClient {
  fetchedRanges: Array<number[] | string> = [];
  private readonly options: {
    uidValidity: number;
    uids: number[];
  };

  constructor(options: { uidValidity: number; uids: number[] }) {
    this.options = options;
  }

  async connect() {}

  close() {}

  async status() {
    return { uidValidity: this.options.uidValidity };
  }

  async mailboxOpen() {
    return { uidValidity: this.options.uidValidity };
  }

  async search() {
    return this.options.uids;
  }

  fetch(range: number[] | string) {
    this.fetchedRanges.push(range);
    const uids = Array.isArray(range) ? range : this.options.uids;
    return asyncIterable(
      uids.map((uid) => ({
        uid,
        flags: new Set<string>(),
        internalDate: new Date(`2030-01-01T00:00:0${uid}.000Z`),
        size: 100,
        source: buildRawMessage(uid),
      })),
    );
  }
}

function mockLogger(): Logger {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    trace: vi.fn(),
    flush: vi.fn(),
    with: vi.fn(),
  } as unknown as Logger;
  logger.with = vi.fn(() => logger);
  return logger;
}

async function* asyncIterable<T>(items: T[]) {
  yield* items;
}

function buildRawMessage(uid: number) {
  return Buffer.from(
    [
      `From: Sender ${uid} <sender-${uid}@example.com>`,
      "To: User <user@example.com>",
      `Subject: Message ${uid}`,
      `Message-ID: <message-${uid}@example.com>`,
      `Date: Tue, 1 Jan 2030 00:00:0${uid} +0000`,
      "",
      `Body ${uid}`,
    ].join("\r\n"),
  );
}
