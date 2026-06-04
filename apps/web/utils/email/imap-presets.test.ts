import { describe, expect, it } from "vitest";
import { STRATO_IMAP_PRESET } from "./imap-presets";

describe("IMAP presets", () => {
  it("exposes STRATO IMAP, SMTP, and username settings", () => {
    expect(STRATO_IMAP_PRESET).toEqual({
      provider: "imap",
      imap: {
        host: "imap.strato.de",
        port: 993,
        secure: true,
      },
      smtp: {
        host: "smtp.strato.de",
        port: 465,
        secure: true,
      },
      usernameBehavior: "full-email-address",
    });
  });
});
