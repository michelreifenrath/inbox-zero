import { ImapFlow } from "imapflow";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { verifyMailboxConnection } from "@/utils/email/imap/connection";
import { ImapProvider } from "@/utils/email/imap/provider";
import {
  pollImapEmailAccounts,
  syncImapMailbox,
  type ImapSyncCursor,
} from "@/utils/email/imap/sync";
import type { MailboxConnectionSettings } from "@/utils/email/imap/connection";
import type { ParsedMessage } from "@/utils/types";

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === "true";

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "local IMAP/SMTP generic mailbox flow",
  { timeout: 30_000 },
  () => {
    let harness: LocalImapSmtpHarness | undefined;

    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });

    test("verifies, syncs, polls, reads supported state, reports unsupported archive/read mutations, and sends an SMTP reply", async () => {
      harness = await startLocalImapSmtpHarness();
      const settings = harness.settings;
      const logger = createTestLogger();

      await verifyMailboxConnection(settings);

      let cursor: ImapSyncCursor | null = null;
      const initiallyProcessed: ParsedMessage[] = [];
      const initialSync = await syncImapMailbox({
        emailAccountId: harness.emailAccountId,
        cursor,
        client: createImapClient(settings),
        processMessage: (message) => initiallyProcessed.push(message),
        saveCursor: (nextCursor) => {
          cursor = nextCursor;
        },
        logger,
      });

      expect(initialSync).toEqual(
        expect.objectContaining({
          emailAccountId: harness.emailAccountId,
          mailbox: "INBOX",
          processed: 1,
          lastUid: 1,
          uidValidity: "777",
          uidValidityChanged: false,
        }),
      );
      expect(initiallyProcessed).toHaveLength(1);
      expect(initiallyProcessed[0]).toEqual(
        expect.objectContaining({
          subject: `Initial ${harness.runId}`,
          textPlain: expect.stringContaining("seed message"),
          labelIds: expect.arrayContaining(["INBOX", "UNREAD"]),
        }),
      );

      const provider = new ImapProvider(settings, logger);
      const inbox = await provider.getInboxMessages(10);
      expect(inbox.map((message) => message.subject)).toEqual([
        `Initial ${harness.runId}`,
      ]);
      expect(inbox[0]?.labelIds).toEqual(expect.arrayContaining(["UNREAD"]));
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
      const incrementallyProcessed: ParsedMessage[] = [];
      const pollResults = await pollImapEmailAccounts({
        emailAccountIds: [harness.emailAccountId],
        logger,
        syncAccount: async ({ emailAccountId }) =>
          syncImapMailbox({
            emailAccountId,
            cursor,
            client: createImapClient(settings),
            processMessage: (message) => incrementallyProcessed.push(message),
            saveCursor: (nextCursor) => {
              cursor = nextCursor;
            },
            logger,
          }),
      });

      expect(pollResults).toEqual([
        expect.objectContaining({
          status: "success",
          processed: 1,
          lastUid: 2,
        }),
      ]);
      expect(incrementallyProcessed.map((message) => message.subject)).toEqual([
        `Incremental ${harness.runId}`,
      ]);

      await provider.replyToEmail(
        incrementallyProcessed[0]!,
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

function createImapClient(settings: MailboxConnectionSettings) {
  return new ImapFlow({
    host: settings.imap.host,
    port: settings.imap.port,
    secure: settings.imap.secure,
    auth: {
      user: settings.username,
      pass: settings.password,
    },
    logger: false,
    connectionTimeout: settings.timeoutMs,
    greetingTimeout: settings.timeoutMs,
    socketTimeout: settings.timeoutMs,
  });
}

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
  emailAccountId: string;
  settings: MailboxConnectionSettings;
  smtpMessages: SmtpMessage[];
  appendInboxMessage(message: {
    from: string;
    subject: string;
    text: string;
  }): StoredMessage;
  close(): Promise<void>;
};

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
    emailAccountId: `email-account-${runId}`,
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
