import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { describe, expect, it, vi } from "vitest";
import { SafeError } from "@/utils/error";
import { STRATO_IMAP_PRESET } from "@/utils/email/imap-presets";
import type { ParsedMessage } from "@/utils/types";
import {
  forwardSmtpEmail,
  replyToSmtpEmail,
  sendSmtpEmail,
  sendSmtpEmailWithHtml,
} from "./smtp";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_EMAIL_SEND_ENABLED: true,
  },
}));

type SentInfo = {
  envelope: { from: string; to: string[] };
  message: Buffer;
  messageId?: string;
};

const settings = {
  imap: STRATO_IMAP_PRESET.imap,
  smtp: STRATO_IMAP_PRESET.smtp,
  username: "user@example.com",
  password: "super-secret-password",
};

describe("IMAP SMTP send", () => {
  it("sends plain text email with MIME headers, recipients, and attachments", async () => {
    const sent: SentInfo[] = [];

    await sendSmtpEmail(
      settings,
      {
        to: "Recipient <to@example.com>",
        cc: "cc@example.com",
        bcc: "bcc@example.com",
        subject: "Hello",
        messageText: "Hello world",
        attachments: [
          {
            filename: "hello.txt",
            content: "attachment body",
            contentType: "text/plain",
          },
        ],
      },
      createStreamClients(sent),
    );

    expect(sent[0].envelope).toEqual({
      from: "user@example.com",
      to: ["to@example.com", "cc@example.com", "bcc@example.com"],
    });

    const parsed = await simpleParser(sent[0].message);
    expect(parsed.from?.text).toBe("user@example.com");
    expect(parsed.to?.value).toEqual([
      { address: "to@example.com", name: "Recipient" },
    ]);
    expect(parsed.cc?.text).toBe("cc@example.com");
    expect(parsed.headers.get("bcc")).toBeUndefined();
    expect(parsed.headers.get("x-mailer")).toBe("Inbox Zero Web");
    expect(parsed.subject).toBe("Hello");
    expect(parsed.text).toContain("Hello world");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({
      filename: "hello.txt",
      contentType: "text/plain",
    });
    expect(parsed.attachments[0].content.toString()).toBe("attachment body");
  });

  it("does not expose SMTP Message-ID as an IMAP provider message ID", async () => {
    const result = await sendSmtpEmail(
      settings,
      {
        to: "to@example.com",
        subject: "Hello",
        messageText: "Body",
      },
      createSmtpInfoClients("<SMTP-ID@Example.COM>"),
    );

    expect(result).toEqual({
      messageId: "",
      threadId: "smtp-id@example.com",
    });
  });

  it("keeps an existing thread ID instead of replacing it with SMTP Message-ID", async () => {
    const result = await sendSmtpEmailWithHtml(
      settings,
      {
        replyToEmail: {
          threadId: "existing-thread@example.com",
          headerMessageId: "parent@example.com",
        },
        to: "to@example.com",
        subject: "Re: Hello",
        messageHtml: "<p>Body</p>",
      },
      createSmtpInfoClients("<SMTP-ID@Example.COM>"),
    );

    expect(result).toEqual({
      messageId: "",
      threadId: "existing-thread@example.com",
    });
  });

  it("replies with SMTP recipients and RFC threading headers", async () => {
    const sent: SentInfo[] = [];

    await replyToSmtpEmail(
      settings,
      buildParsedMessage({
        from: "Sender <sender@example.com>",
        replyTo: "reply@example.com",
        subject: "Question",
        messageId: "parent@example.com",
        references: "root@example.com",
      }),
      "Thanks for checking.",
      {
        from: "Agent <user@example.com>",
        replyTo: "support@example.com",
        attachments: [
          {
            filename: "reply.pdf",
            content: Buffer.from("pdf bytes"),
            contentType: "application/pdf",
          },
        ],
      },
      createStreamClients(sent),
    );

    expect(sent[0].envelope).toEqual({
      from: "user@example.com",
      to: ["reply@example.com"],
    });

    const parsed = await simpleParser(sent[0].message);
    expect(parsed.from?.value).toEqual([
      { address: "user@example.com", name: "Agent" },
    ]);
    expect(parsed.to?.text).toBe("reply@example.com");
    expect(parsed.replyTo?.text).toBe("support@example.com");
    expect(parsed.subject).toBe("Re: Question");
    expect(parsed.headers.get("in-reply-to")).toBe("<parent@example.com>");
    expect(parsed.headers.get("references")).toEqual([
      "<root@example.com>",
      "<parent@example.com>",
    ]);
    expect(parsed.text).toContain("Thanks for checking.");
    expect(parsed.attachments[0]).toMatchObject({
      filename: "reply.pdf",
      contentType: "application/pdf",
    });
    expect(parsed.attachments[0].content.toString()).toBe("pdf bytes");
  });

  it("forwards with SMTP recipients and original attachments", async () => {
    const sent: SentInfo[] = [];

    await forwardSmtpEmail(
      settings,
      buildParsedMessage({
        subject: "Original subject",
        messageId: "original@example.com",
      }),
      {
        to: "forward@example.com",
        cc: "forward-cc@example.com",
        bcc: "forward-bcc@example.com",
        content: "FYI",
        from: "user@example.com",
        attachments: [
          {
            filename: "original.csv",
            content: "a,b,c",
            contentType: "text/csv",
          },
        ],
      },
      createStreamClients(sent),
    );

    expect(sent[0].envelope).toEqual({
      from: "user@example.com",
      to: [
        "forward@example.com",
        "forward-cc@example.com",
        "forward-bcc@example.com",
      ],
    });

    const parsed = await simpleParser(sent[0].message);
    expect(parsed.from?.text).toBe("user@example.com");
    expect(parsed.to?.text).toBe("forward@example.com");
    expect(parsed.cc?.text).toBe("forward-cc@example.com");
    expect(parsed.headers.get("bcc")).toBeUndefined();
    expect(parsed.headers.get("x-mailer")).toBe("Inbox Zero Web");
    expect(parsed.subject).toBe("Fwd: Original subject");
    expect(parsed.headers.get("in-reply-to")).toBeUndefined();
    expect(parsed.headers.get("references")).toBeUndefined();
    expect(parsed.text).toContain("FYI");
    expect(parsed.text).toContain("---------- Forwarded message ----------");
    expect(parsed.attachments[0]).toMatchObject({
      filename: "original.csv",
      contentType: "text/csv",
    });
    expect(parsed.attachments[0].content.toString()).toBe("a,b,c");
  });

  it("maps SMTP failures to safe errors without exposing server details", async () => {
    const clients = {
      createTransport: () => ({
        sendMail: vi.fn(async () => {
          const error = new Error(
            "535 auth failed for user@example.com with super-secret-password",
          );
          Object.assign(error, {
            code: "EAUTH",
            responseCode: 535,
            response: "535 auth failed with super-secret-password",
          });
          throw error;
        }),
        close: vi.fn(),
      }),
    };

    await expect(
      sendSmtpEmail(
        settings,
        {
          to: "to@example.com",
          subject: "Hello",
          messageText: "Body",
        },
        clients,
      ),
    ).rejects.toEqual(
      new SafeError(
        "SMTP authentication failed. Check the mailbox email address and password.",
      ),
    );

    try {
      await sendSmtpEmail(
        settings,
        {
          to: "to@example.com",
          subject: "Hello",
          messageText: "Body",
        },
        clients,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(SafeError);
      expect(String((error as Error).message)).not.toContain(
        "super-secret-password",
      );
      expect(String((error as Error).message)).not.toContain("535");
    }
  });
});

function createStreamClients(sent: SentInfo[]) {
  return {
    createTransport: () => {
      const transport = nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: "unix",
      });
      const sendMail = transport.sendMail.bind(transport);

      return {
        sendMail: vi.fn(async (message) => {
          const info = (await sendMail(message)) as SentInfo;
          sent.push(info);
          return info;
        }),
        close: vi.fn(),
      };
    },
  };
}

function createSmtpInfoClients(messageId: string) {
  return {
    createTransport: () => ({
      sendMail: vi.fn(async () => ({ messageId })),
      close: vi.fn(),
    }),
  };
}

function buildParsedMessage({
  from = "Sender <sender@example.com>",
  replyTo,
  subject,
  messageId,
  references,
}: {
  from?: string;
  replyTo?: string;
  subject: string;
  messageId: string;
  references?: string;
}): ParsedMessage {
  return {
    id: "INBOX:1",
    threadId: references || messageId,
    historyId: "1",
    date: "2030-01-01T10:00:00.000Z",
    internalDate: "1893492000000",
    labelIds: ["INBOX"],
    parentFolderId: "INBOX",
    subject,
    snippet: "Original body",
    textPlain: "Original body",
    textHtml: "<p>Original body</p>",
    bodyContentType: "html",
    attachments: [],
    inline: [],
    headers: {
      date: "2030-01-01T10:00:00.000Z",
      from,
      to: "User <user@example.com>",
      subject,
      "message-id": messageId,
      references,
      "reply-to": replyTo,
    },
  };
}
