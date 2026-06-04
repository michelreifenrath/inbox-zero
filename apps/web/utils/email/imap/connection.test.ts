import { beforeEach, describe, expect, it, vi } from "vitest";
import { STRATO_IMAP_PRESET } from "@/utils/email/imap-presets";
import {
  verifyMailboxConnection,
  type MailboxConnectionClients,
} from "./connection";

vi.mock("server-only", () => ({}));

const settings = {
  imap: STRATO_IMAP_PRESET.imap,
  smtp: STRATO_IMAP_PRESET.smtp,
  username: "user@example.com",
  password: "strato-password",
  timeoutMs: 1000,
};

const imapClient = {
  connect: vi.fn(),
  close: vi.fn(),
};

const smtpClient = {
  verify: vi.fn(),
  close: vi.fn(),
};

const clients: MailboxConnectionClients = {
  createImapClient: vi.fn(() => imapClient),
  createSmtpClient: vi.fn(() => smtpClient),
};

describe("verifyMailboxConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    imapClient.connect.mockResolvedValue(undefined);
    smtpClient.verify.mockResolvedValue(true);
  });

  it("verifies IMAP and SMTP credentials with injected clients", async () => {
    await expect(
      verifyMailboxConnection(settings, clients),
    ).resolves.toBeUndefined();

    expect(clients.createImapClient).toHaveBeenCalledWith({
      host: STRATO_IMAP_PRESET.imap.host,
      port: STRATO_IMAP_PRESET.imap.port,
      secure: STRATO_IMAP_PRESET.imap.secure,
      auth: {
        user: "user@example.com",
        pass: "strato-password",
      },
      logger: false,
      verifyOnly: true,
      connectionTimeout: 1000,
      greetingTimeout: 1000,
      socketTimeout: 1000,
    });
    expect(clients.createSmtpClient).toHaveBeenCalledWith({
      host: STRATO_IMAP_PRESET.smtp.host,
      port: STRATO_IMAP_PRESET.smtp.port,
      secure: STRATO_IMAP_PRESET.smtp.secure,
      auth: {
        user: "user@example.com",
        pass: "strato-password",
      },
      connectionTimeout: 1000,
      greetingTimeout: 1000,
      socketTimeout: 1000,
    });
    expect(imapClient.close).toHaveBeenCalled();
    expect(smtpClient.close).toHaveBeenCalled();
  });

  it("maps IMAP auth failures to a safe user error", async () => {
    imapClient.connect.mockRejectedValue({ authenticationFailed: true });

    await expect(verifyMailboxConnection(settings, clients)).rejects.toThrow(
      "IMAP authentication failed. Check the mailbox email address and password.",
    );
    expect(clients.createSmtpClient).not.toHaveBeenCalled();
    expect(imapClient.close).toHaveBeenCalled();
  });

  it("maps SMTP auth failures to a safe user error", async () => {
    smtpClient.verify.mockRejectedValue({ code: "EAUTH" });

    await expect(verifyMailboxConnection(settings, clients)).rejects.toThrow(
      "SMTP authentication failed. Check the mailbox email address and password.",
    );
    expect(smtpClient.close).toHaveBeenCalled();
  });

  it("maps TLS failures to a safe user error", async () => {
    imapClient.connect.mockRejectedValue({
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });

    await expect(verifyMailboxConnection(settings, clients)).rejects.toThrow(
      "IMAP security check failed. Try again later or contact support.",
    );
    expect(JSON.stringify(imapClient.connect.mock.calls)).not.toContain(
      "strato-password",
    );
  });

  it("maps DNS failures to a safe user error", async () => {
    smtpClient.verify.mockRejectedValue({ code: "ENOTFOUND" });

    await expect(verifyMailboxConnection(settings, clients)).rejects.toThrow(
      "SMTP server could not be reached. Try again later.",
    );
  });

  it("maps timeout failures to a safe user error", async () => {
    imapClient.connect.mockRejectedValue({ code: "ETIMEOUT" });

    await expect(verifyMailboxConnection(settings, clients)).rejects.toThrow(
      "IMAP connection timed out. Try again in a moment.",
    );
  });
});
