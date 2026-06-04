import { describe, expect, it } from "vitest";
import {
  getThreadIdFromHeaders,
  parseImapAttachment,
  parseImapMessage,
} from "./message-parser";

describe("parseImapMessage", () => {
  it("parses RFC822 message bodies, headers, and attachments", async () => {
    const raw = `From: Alice <alice@example.com>
To: Bob <bob@example.com>
Cc: Carol <carol@example.com>
Subject: Quarterly report
Message-ID: <root@example.com>
Date: Tue, 01 Jan 2030 10:00:00 +0000
List-Unsubscribe: <mailto:unsubscribe@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mixed"

--mixed
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset=utf-8

Plain report body.
--alt
Content-Type: text/html; charset=utf-8

<p>HTML report body.</p>
--alt--
--mixed
Content-Type: text/plain; name="report.txt"
Content-Disposition: attachment; filename="report.txt"
Content-Transfer-Encoding: base64

UmVwb3J0IGZpbGU=
--mixed--`;

    const message = await parseImapMessage({
      id: "INBOX:42",
      mailbox: "INBOX",
      uid: 42,
      source: raw,
      flags: new Set(["\\Seen"]),
      internalDate: new Date("2030-01-01T10:05:00.000Z"),
    });

    expect(message).toMatchObject({
      id: "INBOX:42",
      threadId: "root@example.com",
      subject: "Quarterly report",
      textPlain: "Plain report body.",
      textHtml: "<p>HTML report body.</p>",
      parentFolderId: "INBOX",
      headers: {
        from: "Alice <alice@example.com>",
        to: "Bob <bob@example.com>",
        cc: "Carol <carol@example.com>",
        "message-id": "root@example.com",
        "list-unsubscribe": "<mailto:unsubscribe@example.com>",
      },
    });
    expect(message.snippet).toBe("Plain report body.");
    expect(message.attachments).toEqual([
      expect.objectContaining({
        attachmentId: "imap-attachment-0",
        filename: "report.txt",
        mimeType: "text/plain",
        size: 11,
      }),
    ]);

    await expect(
      parseImapAttachment(raw, "imap-attachment-0"),
    ).resolves.toEqual({
      data: Buffer.from("Report file").toString("base64"),
      size: 11,
    });
  });

  it("uses References before In-Reply-To for local thread ids", async () => {
    expect(
      getThreadIdFromHeaders({
        "message-id": "reply@example.com",
        "in-reply-to": "parent@example.com",
        references: "root@example.com parent@example.com",
      }),
    ).toBe("root@example.com");
  });
});
