import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { GmailProvider } from "@/utils/email/google";
import { ImapProvider } from "@/utils/email/imap/provider";
import { OutlookProvider } from "@/utils/email/microsoft";
import { assertProviderNotRateLimited } from "@/utils/email/rate-limit";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { getOutlookClientWithRefresh } from "@/utils/outlook/client";
import { createEmailProvider } from "./provider";

vi.mock("@/utils/prisma");

vi.mock("@/utils/gmail/client", () => ({
  getAccessTokenFromClient: vi.fn(),
  getGmailClientWithRefresh: vi.fn(),
}));

vi.mock("@/utils/outlook/client", () => ({
  getAccessTokenFromClient: vi.fn(),
  getOutlookClientWithRefresh: vi.fn(),
}));

vi.mock("@/utils/email/google", () => ({
  GmailProvider: vi.fn(function GmailProvider(
    client: unknown,
    logger: unknown,
    emailAccountId: string,
  ) {
    return { name: "google", client, logger, emailAccountId };
  }),
}));

vi.mock("@/utils/email/imap/provider", () => ({
  ImapProvider: vi.fn(function ImapProvider(
    settings: unknown,
    logger: unknown,
  ) {
    return { name: "imap", settings, logger };
  }),
}));

vi.mock("@/utils/email/microsoft", () => ({
  OutlookProvider: vi.fn(function OutlookProvider(
    client: unknown,
    logger: unknown,
  ) {
    return { name: "microsoft", client, logger };
  }),
}));

vi.mock("@/utils/email/rate-limit", () => ({
  assertProviderNotRateLimited: vi.fn(),
}));

const logger = createTestLogger();
const emailAccountId = "email-account-1";

describe("createEmailProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a Gmail provider without using IMAP connection lookup", async () => {
    const gmailClient = { provider: "gmail-client" };
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(
      oauthEmailAccount({ provider: "google" }) as never,
    );
    vi.mocked(getGmailClientWithRefresh).mockResolvedValue(
      gmailClient as never,
    );

    const provider = await createEmailProvider({
      emailAccountId,
      provider: "google",
      logger,
    });

    expect(provider).toEqual(
      expect.objectContaining({ name: "google", client: gmailClient }),
    );
    expect(assertProviderNotRateLimited).toHaveBeenCalledWith({
      emailAccountId,
      provider: "google",
      logger,
      source: "create-email-provider",
    });
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: emailAccountId },
      select: {
        account: {
          select: {
            access_token: true,
            refresh_token: true,
            expires_at: true,
            scope: true,
            disconnectedAt: true,
          },
        },
      },
    });
    expect(prisma.emailConnection.findUnique).not.toHaveBeenCalled();
    expect(getGmailClientWithRefresh).toHaveBeenCalledWith({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 4_102_444_800_000,
      emailAccountId,
      logger,
    });
    expect(GmailProvider).toHaveBeenCalledWith(
      gmailClient,
      logger,
      emailAccountId,
    );
    expect(getOutlookClientWithRefresh).not.toHaveBeenCalled();
  });

  it("creates a Microsoft provider without using IMAP connection lookup", async () => {
    const outlookClient = { provider: "outlook-client" };
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(
      oauthEmailAccount({ provider: "microsoft" }) as never,
    );
    vi.mocked(getOutlookClientWithRefresh).mockResolvedValue(
      outlookClient as never,
    );

    const provider = await createEmailProvider({
      emailAccountId,
      provider: "microsoft",
      logger,
    });

    expect(provider).toEqual(
      expect.objectContaining({ name: "microsoft", client: outlookClient }),
    );
    expect(assertProviderNotRateLimited).toHaveBeenCalledWith({
      emailAccountId,
      provider: "microsoft",
      logger,
      source: "create-email-provider",
    });
    expect(prisma.emailConnection.findUnique).not.toHaveBeenCalled();
    expect(getOutlookClientWithRefresh).toHaveBeenCalledWith({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 4_102_444_800_000,
      emailAccountId,
      logger,
    });
    expect(OutlookProvider).toHaveBeenCalledWith(outlookClient, logger);
    expect(getGmailClientWithRefresh).not.toHaveBeenCalled();
  });

  it("creates an IMAP provider from connection settings without OAuth lookup", async () => {
    vi.mocked(prisma.emailConnection.findUnique).mockResolvedValue(
      imapConnection() as never,
    );

    const provider = await createEmailProvider({
      emailAccountId,
      provider: "imap",
      logger,
    });

    expect(provider).toEqual(
      expect.objectContaining({
        name: "imap",
        settings: {
          imap: { host: "imap.example.com", port: 993, secure: true },
          smtp: { host: "smtp.example.com", port: 465, secure: true },
          username: "user@example.com",
          password: "password",
        },
      }),
    );
    expect(prisma.emailConnection.findUnique).toHaveBeenCalledWith({
      where: { emailAccountId },
      select: {
        imapHost: true,
        imapPort: true,
        imapSecure: true,
        smtpHost: true,
        smtpPort: true,
        smtpSecure: true,
        username: true,
        password: true,
        isConnected: true,
      },
    });
    expect(ImapProvider).toHaveBeenCalledWith(
      {
        imap: { host: "imap.example.com", port: 993, secure: true },
        smtp: { host: "smtp.example.com", port: 465, secure: true },
        username: "user@example.com",
        password: "password",
      },
      logger,
    );
    expect(assertProviderNotRateLimited).not.toHaveBeenCalled();
    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
    expect(getGmailClientWithRefresh).not.toHaveBeenCalled();
    expect(getOutlookClientWithRefresh).not.toHaveBeenCalled();
  });

  it("fails safely when an IMAP account has no connection", async () => {
    vi.mocked(prisma.emailConnection.findUnique).mockResolvedValue(null);

    await expect(
      createEmailProvider({
        emailAccountId,
        provider: "imap",
        logger,
      }),
    ).rejects.toMatchObject({ name: "SafeError", statusCode: 404 });

    expect(ImapProvider).not.toHaveBeenCalled();
    expect(assertProviderNotRateLimited).not.toHaveBeenCalled();
    expect(getGmailClientWithRefresh).not.toHaveBeenCalled();
    expect(getOutlookClientWithRefresh).not.toHaveBeenCalled();
  });

  it("fails safely when an IMAP connection is disconnected", async () => {
    vi.mocked(prisma.emailConnection.findUnique).mockResolvedValue(
      imapConnection({ isConnected: false }) as never,
    );

    await expect(
      createEmailProvider({
        emailAccountId,
        provider: "imap",
        logger,
      }),
    ).rejects.toMatchObject({ name: "SafeError", statusCode: 403 });

    expect(ImapProvider).not.toHaveBeenCalled();
    expect(assertProviderNotRateLimited).not.toHaveBeenCalled();
    expect(getGmailClientWithRefresh).not.toHaveBeenCalled();
    expect(getOutlookClientWithRefresh).not.toHaveBeenCalled();
  });

  it("fails safely when the account is disconnected", async () => {
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(
      oauthEmailAccount({
        provider: "google",
        disconnectedAt: new Date("2026-06-01T00:00:00.000Z"),
      }) as never,
    );

    await expect(
      createEmailProvider({
        emailAccountId,
        provider: "google",
        logger,
      }),
    ).rejects.toMatchObject({ name: "SafeError", statusCode: 403 });

    expect(assertProviderNotRateLimited).toHaveBeenCalledWith({
      emailAccountId,
      provider: "google",
      logger,
      source: "create-email-provider",
    });
    expect(getGmailClientWithRefresh).not.toHaveBeenCalled();
    expect(getOutlookClientWithRefresh).not.toHaveBeenCalled();
    expect(prisma.emailConnection.findUnique).not.toHaveBeenCalled();
  });

  it("fails safely for unsupported providers", async () => {
    await expect(
      createEmailProvider({
        emailAccountId,
        provider: "unsupported",
        logger,
      }),
    ).rejects.toMatchObject({ name: "SafeError", statusCode: 400 });

    expect(assertProviderNotRateLimited).not.toHaveBeenCalled();
    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
    expect(prisma.emailConnection.findUnique).not.toHaveBeenCalled();
    expect(getGmailClientWithRefresh).not.toHaveBeenCalled();
    expect(getOutlookClientWithRefresh).not.toHaveBeenCalled();
  });
});

function oauthEmailAccount({
  provider,
  disconnectedAt = null,
}: {
  provider: "google" | "microsoft";
  disconnectedAt?: Date | null;
}) {
  return {
    account: {
      provider,
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_at: new Date("2100-01-01T00:00:00.000Z"),
      scope: "scope",
      disconnectedAt,
    },
  };
}

function imapConnection({
  isConnected = true,
}: {
  isConnected?: boolean;
} = {}) {
  return {
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecure: true,
    username: "user@example.com",
    password: "password",
    isConnected,
  };
}
