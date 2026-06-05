import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { connectImapMailboxAction } from "@/utils/actions/imap-connection";
import { createEmailProvider } from "@/utils/email/provider";
import { IMAP_PROVIDER } from "@/utils/email/provider-types";
import { pollImapEmailAccounts } from "@/utils/email/imap/sync";
import type { MailboxConnectionSettings } from "@/utils/email/imap/connection";

const testAuthState = vi.hoisted(() => ({
  session: null as { user: { id: string; email: string } } | null,
}));

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => testAuthState.session),
}));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));
vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");

  return {
    ...actual,
    isIP: (input: string) => (input === "127.0.0.1" ? 0 : actual.isIP(input)),
  };
});

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === "true";

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "local IMAP/SMTP generic mailbox flow",
  { timeout: 30_000 },
  () => {
    let harness: LocalImapSmtpHarness | undefined;
    let database: TestDatabase;

    beforeEach(() => {
      database = createTestDatabase();
      installPrismaMocks(database);
      testAuthState.session = null;
    });

    afterEach(async () => {
      await harness?.close();
      harness = undefined;
      testAuthState.session = null;
    });

    test("signs in with credentials, connects a mailbox through the app action, syncs, polls, reads supported state, reports unsupported archive/read mutations, and sends an SMTP reply", async () => {
      harness = await startLocalImapSmtpHarness();
      const settings = harness.settings;
      const logger = createTestLogger();
      const session = await signUpAndSignInWithCredentials({
        database,
        email: `login-${harness.runId}@example.test`,
        password: `login-pw-${harness.runId}`,
      });
      testAuthState.session = session;

      const connected = await connectImapMailboxAction({
        preset: "custom",
        email: settings.username,
        password: settings.password,
        username: settings.username,
        imapHost: settings.imap.host,
        imapPort: settings.imap.port,
        imapSecure: settings.imap.secure,
        smtpHost: settings.smtp.host,
        smtpPort: settings.smtp.port,
        smtpSecure: settings.smtp.secure,
      });

      expect(connected?.serverError).toBeUndefined();
      expect(connected?.data).toEqual(
        expect.objectContaining({
          status: "created",
          email: settings.username,
        }),
      );
      const emailAccountId = connected?.data?.emailAccountId;
      expect(emailAccountId).toBeTruthy();

      const initialPollResults = await pollImapEmailAccounts({
        emailAccountIds: [emailAccountId!],
        logger,
      });

      expect(initialPollResults).toEqual([
        expect.objectContaining({
          emailAccountId,
          status: "success",
          mailbox: "INBOX",
          processed: 1,
          lastUid: 1,
          uidValidity: "777",
          uidValidityChanged: false,
        }),
      ]);

      const provider = await createEmailProvider({
        emailAccountId: emailAccountId!,
        provider: IMAP_PROVIDER,
        logger,
      });
      const inbox = await provider.getInboxMessages(10);
      expect(inbox.map((message) => message.subject)).toEqual([
        `Initial ${harness.runId}`,
      ]);
      expect(inbox[0]).toEqual(
        expect.objectContaining({
          subject: `Initial ${harness.runId}`,
          textPlain: expect.stringContaining("seed message"),
          labelIds: expect.arrayContaining(["INBOX", "UNREAD"]),
        }),
      );
      await expect(
        provider.markReadThread(inbox[0]!.threadId, true),
      ).rejects.toThrow("read-only");
      await expect(
        provider.archiveThread(inbox[0]!.threadId, settings.username),
      ).rejects.toThrow("read-only");

      harness.appendInboxMessage({
        from: `sender-${harness.runId}@example.net`,
        subject: `Incremental ${harness.runId}`,
        text: "incremental message",
      });
      const incrementalPollResults = await pollImapEmailAccounts({
        emailAccountIds: [emailAccountId!],
        logger,
      });

      expect(incrementalPollResults).toEqual([
        expect.objectContaining({
          emailAccountId,
          status: "success",
          processed: 1,
          lastUid: 2,
        }),
      ]);

      const updatedInbox = await provider.getInboxMessages(10);
      expect(updatedInbox.map((message) => message.subject)).toEqual(
        expect.arrayContaining([
          `Initial ${harness.runId}`,
          `Incremental ${harness.runId}`,
        ]),
      );

      await provider.replyToEmail(
        updatedInbox.find(
          (message) => message.subject === `Incremental ${harness.runId}`,
        )!,
        `Reply body ${harness.runId}`,
      );

      expect(harness.smtpMessages).toHaveLength(1);
      expect(harness.smtpMessages[0]).toEqual(
        expect.objectContaining({
          from: settings.username,
          to: [`sender-${harness.runId}@example.net`],
          data: expect.stringContaining(`Reply body ${harness.runId}`),
        }),
      );
      expect(harness.smtpMessages[0]?.data).toContain(
        `In-Reply-To: <incremental-${harness.runId}@example.net>`,
      );
    });
  },
);

type TestUser = {
  id: string;
  email: string;
  password: string;
};

type TestAccount = {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  type: string;
  disconnectedAt: Date | null;
};

type TestEmailAccount = {
  id: string;
  email: string;
  userId: string;
  accountId: string;
  imapSyncCursor: unknown;
};

type TestEmailConnection = {
  emailAccountId: string;
  protocol: string;
  preset: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password: string;
  isConnected: boolean;
  syncCursor: unknown;
  lastSyncedAt: Date | null;
};

type TestDatabase = {
  users: Map<string, TestUser>;
  accounts: Map<string, TestAccount>;
  emailAccounts: Map<string, TestEmailAccount>;
  emailConnections: Map<string, TestEmailConnection>;
};

type StoredMessage = {
  uid: number;
  flags: Set<string>;
  internalDate: Date;
  raw: Buffer;
};

type SmtpMessage = {
  from: string;
  to: string[];
  data: string;
};

type LocalImapSmtpHarness = {
  runId: string;
  settings: MailboxConnectionSettings;
  smtpMessages: SmtpMessage[];
  appendInboxMessage(message: {
    from: string;
    subject: string;
    text: string;
  }): StoredMessage;
  close(): Promise<void>;
};

function createTestDatabase(): TestDatabase {
  return {
    users: new Map(),
    accounts: new Map(),
    emailAccounts: new Map(),
    emailConnections: new Map(),
  };
}

async function signUpAndSignInWithCredentials({
  database,
  email,
  password,
}: {
  database: TestDatabase;
  email: string;
  password: string;
}) {
  const user = {
    id: `user-${database.users.size + 1}`,
    email,
    password,
  };
  database.users.set(user.id, user);

  const signedInUser = Array.from(database.users.values()).find(
    (storedUser) =>
      storedUser.email === email && storedUser.password === password,
  );
  if (!signedInUser) throw new Error("Credentials sign-in failed");

  return { user: { id: signedInUser.id, email: signedInUser.email } };
}

function installPrismaMocks(database: TestDatabase) {
  prisma.emailAccount.findUnique.mockImplementation(async (args) => {
    const emailAccount = getEmailAccount(database, args.where);
    if (!emailAccount) return null;

    const account = database.accounts.get(emailAccount.accountId);
    return {
      ...emailAccount,
      about: null,
      multiRuleSelectionEnabled: false,
      sensitiveDataPolicy: null,
      timezone: "UTC",
      calendarBookingLink: null,
      draftReplyConfidence: null,
      autoCategorizeSenders: false,
      filingEnabled: false,
      filingPrompt: null,
      filingConfirmationSendEmail: false,
      account: account
        ? {
            id: account.id,
            provider: account.provider,
            disconnectedAt: account.disconnectedAt,
            userId: account.userId,
          }
        : null,
      rules: [],
      user: {
        aiProvider: null,
        aiModel: null,
        aiApiKey: null,
        premium: null,
      },
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>;
  });

  prisma.account.findUnique.mockImplementation(async (args) => {
    const providerAccountId = args.where.provider_providerAccountId;
    if (!providerAccountId) return null;

    return (Array.from(database.accounts.values()).find(
      (account) =>
        account.provider === providerAccountId.provider &&
        account.providerAccountId === providerAccountId.providerAccountId,
    ) ?? null) as Awaited<ReturnType<typeof prisma.account.findUnique>>;
  });

  prisma.emailAccount.create.mockImplementation(async (args) => {
    const emailAccountId = `email-account-${database.emailAccounts.size + 1}`;
    const email = args.data.email;
    const userId = args.data.user.connect?.id;
    const connectedAccountId = args.data.account?.connect?.id;
    const createdAccount = args.data.account?.create;
    const accountId =
      connectedAccountId ?? `account-${database.accounts.size + 1}`;

    if (!userId) throw new Error("Missing user for email account");

    if (createdAccount) {
      database.accounts.set(accountId, {
        id: accountId,
        userId: createdAccount.userId,
        provider: createdAccount.provider,
        providerAccountId: createdAccount.providerAccountId,
        type: createdAccount.type,
        disconnectedAt: createdAccount.disconnectedAt,
      });
    }

    database.emailAccounts.set(emailAccountId, {
      id: emailAccountId,
      email,
      userId,
      accountId,
      imapSyncCursor: null,
    });

    return {
      id: emailAccountId,
      email,
    } as Awaited<ReturnType<typeof prisma.emailAccount.create>>;
  });

  prisma.emailAccount.update.mockImplementation(async (args) => {
    const emailAccount = database.emailAccounts.get(args.where.id);
    if (!emailAccount) throw new Error("Email account not found");

    if ("imapSyncCursor" in args.data) {
      emailAccount.imapSyncCursor = args.data.imapSyncCursor;
    }

    return emailAccount as Awaited<
      ReturnType<typeof prisma.emailAccount.update>
    >;
  });

  prisma.emailConnection.create.mockImplementation(async (args) => {
    const connection = args.data as TestEmailConnection;
    database.emailConnections.set(connection.emailAccountId, connection);
    return connection as Awaited<
      ReturnType<typeof prisma.emailConnection.create>
    >;
  });

  prisma.emailConnection.findUnique.mockImplementation(async (args) => {
    const emailAccountId = args.where.emailAccountId;
    return (database.emailConnections.get(emailAccountId) ?? null) as Awaited<
      ReturnType<typeof prisma.emailConnection.findUnique>
    >;
  });
}

function getEmailAccount(
  database: TestDatabase,
  where: { id?: string; email?: string },
) {
  if (where.id) return database.emailAccounts.get(where.id) ?? null;
  if (where.email) {
    return (
      Array.from(database.emailAccounts.values()).find(
        (emailAccount) => emailAccount.email === where.email,
      ) ?? null
    );
  }

  return null;
}

async function startLocalImapSmtpHarness(): Promise<LocalImapSmtpHarness> {
  const runId = Math.random().toString(36).slice(2, 10);
  const username = `imap-${runId}@example.test`;
  const password = `pw-${runId}`;
  const mailbox = new LocalMailbox(runId, username);
  const smtpMessages: SmtpMessage[] = [];
  const imapServer = await listen((socket) =>
    handleImapSocket(socket, { username, password, mailbox }),
  );
  const smtpServer = await listen((socket) =>
    handleSmtpSocket(socket, { username, password, smtpMessages }),
  );

  mailbox.append({
    from: `sender-${runId}@example.net`,
    subject: `Initial ${runId}`,
    text: "seed message",
    messageId: `initial-${runId}@example.net`,
  });

  return {
    runId,
    settings: {
      imap: {
        host: "127.0.0.1",
        port: portOf(imapServer),
        secure: false,
      },
      smtp: {
        host: "127.0.0.1",
        port: portOf(smtpServer),
        secure: false,
      },
      username,
      password,
      timeoutMs: 5000,
    },
    smtpMessages,
    appendInboxMessage: ({ from, subject, text }) =>
      mailbox.append({
        from,
        subject,
        text,
        messageId: `incremental-${runId}@example.net`,
      }),
    close: async () => {
      await Promise.all([closeServer(imapServer), closeServer(smtpServer)]);
    },
  };
}

class LocalMailbox {
  private nextUid = 1;
  private readonly messages: StoredMessage[] = [];
  private readonly runId: string;
  private readonly to: string;

  constructor(runId: string, to: string) {
    this.runId = runId;
    this.to = to;
  }

  append({
    from,
    subject,
    text,
    messageId,
  }: {
    from: string;
    subject: string;
    text: string;
    messageId: string;
  }) {
    const uid = this.nextUid++;
    const internalDate = new Date(Date.UTC(2030, 0, 1, 0, 0, uid));
    const raw = Buffer.from(
      [
        `Message-ID: <${messageId}>`,
        `Date: ${internalDate.toUTCString()}`,
        `From: ${from}`,
        `To: ${this.to}`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: 7bit",
        `X-Test-Run: ${this.runId}`,
        "",
        text,
        "",
      ].join("\r\n"),
    );
    const message = {
      uid,
      flags: new Set<string>(),
      internalDate,
      raw,
    };
    this.messages.push(message);
    return message;
  }

  all() {
    return [...this.messages];
  }

  byUid(uids: number[]) {
    const wanted = new Set(uids);
    return this.messages.filter((message) => wanted.has(message.uid));
  }
}

async function listen(handler: (socket: Socket) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function portOf(server: Server) {
  const address = server.address();
  if (typeof address !== "object" || !address?.port) {
    throw new Error("Test server did not bind to a TCP port");
  }
  return address.port;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function handleImapSocket(
  socket: Socket,
  {
    username,
    password,
    mailbox,
  }: { username: string; password: string; mailbox: LocalMailbox },
) {
  socket.setEncoding("utf8");
  let buffer = "";
  let selectedMailbox = false;
  let pendingAuthenticateTag: string | null = null;

  writeLine(socket, "* OK local deterministic IMAP ready");

  socket.on("data", (chunk) => {
    buffer += chunk;
    let lineEnd = buffer.indexOf("\r\n");
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);
      handleImapLine(line);
      lineEnd = buffer.indexOf("\r\n");
    }
  });

  function handleImapLine(line: string) {
    if (pendingAuthenticateTag) {
      const [, user, pass] = Buffer.from(line, "base64")
        .toString("utf8")
        .split("\u0000");
      writeLine(
        socket,
        user === username && pass === password
          ? `${pendingAuthenticateTag} OK AUTHENTICATE completed`
          : `${pendingAuthenticateTag} NO authentication failed`,
      );
      pendingAuthenticateTag = null;
      return;
    }

    const { tag, command, rest } = parseTaggedCommand(line);
    const upperCommand = command.toUpperCase();

    if (upperCommand === "CAPABILITY") {
      writeLine(socket, "* CAPABILITY IMAP4rev1 UIDPLUS AUTH=PLAIN");
      writeLine(socket, `${tag} OK CAPABILITY completed`);
      return;
    }

    if (upperCommand === "ID" || upperCommand === "NOOP") {
      writeLine(socket, `${tag} OK ${upperCommand} completed`);
      return;
    }

    if (upperCommand === "AUTHENTICATE" && rest.toUpperCase() === "PLAIN") {
      pendingAuthenticateTag = tag;
      writeLine(socket, "+");
      return;
    }

    if (upperCommand === "LOGIN") {
      const [user, pass] = parseQuotedAtoms(rest);
      if (user === username && pass === password) {
        writeLine(socket, `${tag} OK LOGIN completed`);
      } else {
        writeLine(socket, `${tag} NO authentication failed`);
      }
      return;
    }

    if (upperCommand === "LOGOUT") {
      writeLine(socket, "* BYE logout requested");
      writeLine(socket, `${tag} OK LOGOUT completed`);
      socket.end();
      return;
    }

    if (upperCommand === "LIST") {
      writeLine(socket, '* LIST () "/" "INBOX"');
      writeLine(socket, `${tag} OK LIST completed`);
      return;
    }

    if (upperCommand === "LSUB") {
      writeLine(socket, `${tag} OK LSUB completed`);
      return;
    }

    if (upperCommand === "STATUS") {
      const messages = mailbox.all();
      const unseen = messages.filter((message) => !message.flags.has("\\Seen"));
      writeLine(
        socket,
        `* STATUS INBOX (MESSAGES ${messages.length} UNSEEN ${unseen.length} UIDVALIDITY 777 UIDNEXT ${messages.length + 1})`,
      );
      writeLine(socket, `${tag} OK STATUS completed`);
      return;
    }

    if (upperCommand === "SELECT" || upperCommand === "EXAMINE") {
      selectedMailbox = true;
      writeLine(
        socket,
        "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)",
      );
      writeLine(socket, `* ${mailbox.all().length} EXISTS`);
      writeLine(socket, "* 0 RECENT");
      writeLine(socket, "* OK [UIDVALIDITY 777] UIDs valid");
      writeLine(
        socket,
        `* OK [UIDNEXT ${mailbox.all().length + 1}] predicted next UID`,
      );
      writeLine(
        socket,
        `${tag} OK [${upperCommand === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${upperCommand} completed`,
      );
      return;
    }

    if (upperCommand === "CLOSE") {
      selectedMailbox = false;
      writeLine(socket, `${tag} OK CLOSE completed`);
      return;
    }

    if (upperCommand === "UID" && rest.toUpperCase().startsWith("SEARCH")) {
      const uids = mailbox
        .all()
        .map((message) => message.uid)
        .join(" ");
      writeLine(socket, `* SEARCH${uids ? ` ${uids}` : ""}`);
      writeLine(socket, `${tag} OK UID SEARCH completed`);
      return;
    }

    if (upperCommand === "SEARCH") {
      const uids = mailbox
        .all()
        .map((message) => message.uid)
        .join(" ");
      writeLine(socket, `* SEARCH${uids ? ` ${uids}` : ""}`);
      writeLine(socket, `${tag} OK SEARCH completed`);
      return;
    }

    if (upperCommand === "UID" && rest.toUpperCase().startsWith("FETCH")) {
      if (!selectedMailbox) {
        writeLine(socket, `${tag} BAD no mailbox selected`);
        return;
      }
      const uidSet = rest.match(/^FETCH\s+([^\s]+)/i)?.[1] || "";
      for (const message of mailbox.byUid(expandUidSet(uidSet))) {
        writeFetchResponse(socket, message);
      }
      writeLine(socket, `${tag} OK UID FETCH completed`);
      return;
    }

    writeLine(socket, `${tag} BAD unsupported command`);
  }
}

function parseTaggedCommand(line: string) {
  const [tag = "*", command = "", ...rest] = line.split(" ");
  return { tag, command, rest: rest.join(" ") };
}

function parseQuotedAtoms(value: string) {
  return Array.from(value.matchAll(/"((?:\\.|[^"])*)"|([^\s]+)/g)).map(
    (match) => (match[1] ?? match[2] ?? "").replace(/\\"/g, '"'),
  );
}

function expandUidSet(uidSet: string) {
  const uids: number[] = [];
  for (const part of uidSet.split(",")) {
    const [start, end] = part.split(":").map(Number);
    if (!Number.isFinite(start)) continue;
    if (Number.isFinite(end)) {
      for (let uid = start; uid <= end; uid++) uids.push(uid);
    } else {
      uids.push(start);
    }
  }
  return uids;
}

function writeFetchResponse(socket: Socket, message: StoredMessage) {
  const flags = Array.from(message.flags).join(" ");
  writeLine(
    socket,
    `* ${message.uid} FETCH (UID ${message.uid} FLAGS (${flags}) INTERNALDATE "${formatImapDate(message.internalDate)}" RFC822.SIZE ${message.raw.length} BODY[] {${message.raw.length}}`,
  );
  socket.write(message.raw);
  writeLine(socket, ")");
}

function formatImapDate(date: Date) {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${day}-${month}-${year} ${hours}:${minutes}:${seconds} +0000`;
}

function handleSmtpSocket(
  socket: Socket,
  {
    username,
    password,
    smtpMessages,
  }: { username: string; password: string; smtpMessages: SmtpMessage[] },
) {
  socket.setEncoding("utf8");
  let buffer = "";
  let mode: "command" | "data" = "command";
  let data = "";
  let from = "";
  let to: string[] = [];

  writeLine(socket, "220 local deterministic SMTP ready");

  socket.on("data", (chunk) => {
    buffer += chunk;
    let lineEnd = buffer.indexOf("\r\n");
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);
      if (mode === "data") {
        if (line === ".") {
          smtpMessages.push({ from, to, data });
          data = "";
          mode = "command";
          writeLine(socket, "250 2.0.0 queued");
        } else {
          data += `${line}\r\n`;
        }
      } else {
        handleSmtpLine(line);
      }
      lineEnd = buffer.indexOf("\r\n");
    }
  });

  function handleSmtpLine(line: string) {
    const upper = line.toUpperCase();
    if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
      writeLine(socket, "250-localhost");
      writeLine(socket, "250-AUTH PLAIN LOGIN");
      writeLine(socket, "250 SIZE 10485760");
      return;
    }

    if (upper.startsWith("AUTH PLAIN")) {
      const encoded = line.split(" ")[2] || "";
      const [, user, pass] = Buffer.from(encoded, "base64")
        .toString("utf8")
        .split("\u0000");
      writeLine(
        socket,
        user === username && pass === password
          ? "235 2.7.0 authentication successful"
          : "535 5.7.8 authentication failed",
      );
      return;
    }

    if (upper.startsWith("MAIL FROM:")) {
      from = extractSmtpAddress(line);
      to = [];
      writeLine(socket, "250 2.1.0 ok");
      return;
    }

    if (upper.startsWith("RCPT TO:")) {
      to.push(extractSmtpAddress(line));
      writeLine(socket, "250 2.1.5 ok");
      return;
    }

    if (upper === "DATA") {
      mode = "data";
      writeLine(socket, "354 end with <CR><LF>.<CR><LF>");
      return;
    }

    if (upper === "RSET") {
      from = "";
      to = [];
      data = "";
      writeLine(socket, "250 2.0.0 reset");
      return;
    }

    if (upper === "QUIT") {
      writeLine(socket, "221 2.0.0 bye");
      socket.end();
      return;
    }

    writeLine(socket, "250 2.0.0 ok");
  }
}

function extractSmtpAddress(line: string) {
  return (
    line.match(/<([^>]+)>/)?.[1] || line.split(":").slice(1).join(":").trim()
  );
}

function writeLine(socket: Socket, line: string) {
  socket.write(`${line}\r\n`);
}
