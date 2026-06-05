import { lookup } from "node:dns/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { verifyMailboxConnection } from "@/utils/email/imap/connection";
import { STRATO_IMAP_PRESET } from "@/utils/email/imap-presets";
import { SafeError } from "@/utils/error";
import {
  connectImapMailboxAction,
  connectStratoMailboxAction,
} from "./imap-connection";

vi.mock("@/utils/prisma");
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));
vi.mock("@/utils/email/imap/connection", () => ({
  verifyMailboxConnection: vi.fn(),
}));
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));

const input = {
  email: "USER@EXAMPLE.COM ",
  password: "strato-password",
};

const stratoConnectionData = {
  protocol: "imap",
  preset: "strato",
  imapHost: STRATO_IMAP_PRESET.imap.host,
  imapPort: STRATO_IMAP_PRESET.imap.port,
  imapSecure: STRATO_IMAP_PRESET.imap.secure,
  smtpHost: STRATO_IMAP_PRESET.smtp.host,
  smtpPort: STRATO_IMAP_PRESET.smtp.port,
  smtpSecure: STRATO_IMAP_PRESET.smtp.secure,
  username: "user@example.com",
  password: "strato-password",
  isConnected: true,
  syncCursor: null,
  lastSyncedAt: null,
};

const customInput = {
  preset: "custom" as const,
  email: "USER@EXAMPLE.COM ",
  password: "custom-password",
  username: "imap-user",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecure: false,
};

const customConnectionData = {
  protocol: "imap",
  preset: "custom",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecure: false,
  username: "imap-user",
  password: "custom-password",
  isConnected: true,
  syncCursor: null,
  lastSyncedAt: null,
};

const mockedLookup = vi.mocked(lookup);
const mockedVerifyMailboxConnection = vi.mocked(verifyMailboxConnection);

describe("connectStratoMailboxAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mockedVerifyMailboxConnection.mockResolvedValue(undefined);
    prisma.emailAccount.findUnique.mockResolvedValue(null);
    prisma.account.findUnique.mockResolvedValue(null);
    prisma.emailAccount.create.mockResolvedValue({
      id: "email-account-1",
      email: "user@example.com",
    } as Awaited<ReturnType<typeof prisma.emailAccount.create>>);
  });

  it("saves a valid STRATO mailbox with IMAP defaults", async () => {
    const result = await connectStratoMailboxAction(input);

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({
      status: "created",
      emailAccountId: "email-account-1",
      email: "user@example.com",
    });
    expect(mockedVerifyMailboxConnection).toHaveBeenCalledWith({
      imap: STRATO_IMAP_PRESET.imap,
      smtp: STRATO_IMAP_PRESET.smtp,
      username: "user@example.com",
      password: "strato-password",
    });
    expect(prisma.emailAccount.create).toHaveBeenCalledWith({
      data: {
        email: "user@example.com",
        user: { connect: { id: "user-1" } },
        account: {
          create: {
            userId: "user-1",
            provider: "imap",
            providerAccountId: "user@example.com",
            type: "imap",
            disconnectedAt: null,
          },
        },
      },
      select: { id: true, email: true },
    });
    expect(prisma.emailConnection.create).toHaveBeenCalledWith({
      data: {
        ...stratoConnectionData,
        emailAccountId: "email-account-1",
      },
    });
    expect(JSON.stringify(result?.data)).not.toContain("strato-password");
  });

  it("saves a valid custom IMAP mailbox with explicit server settings", async () => {
    const result = await connectImapMailboxAction(customInput);

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({
      status: "created",
      emailAccountId: "email-account-1",
      email: "user@example.com",
    });
    expect(mockedVerifyMailboxConnection).toHaveBeenCalledWith({
      imap: {
        host: "imap.example.com",
        port: 993,
        secure: true,
      },
      smtp: {
        host: "smtp.example.com",
        port: 587,
        secure: false,
      },
      username: "imap-user",
      password: "custom-password",
    });
    expect(prisma.emailConnection.create).toHaveBeenCalledWith({
      data: {
        ...customConnectionData,
        emailAccountId: "email-account-1",
      },
    });
    expect(JSON.stringify(result?.data)).not.toContain("custom-password");
  });

  it("rejects custom hosts that resolve to private addresses", async () => {
    mockedLookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);

    const result = await connectImapMailboxAction(customInput);

    expect(result?.serverError).toBe("Mailbox server host is not allowed.");
    expect(mockedVerifyMailboxConnection).not.toHaveBeenCalled();
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
    expect(prisma.emailConnection.create).not.toHaveBeenCalled();
    expect(prisma.emailConnection.upsert).not.toHaveBeenCalled();
  });

  it("rejects custom loopback hosts before resolving or connecting", async () => {
    const result = await connectImapMailboxAction({
      ...customInput,
      imapHost: "localhost",
    });

    expect(result?.serverError).toBe("Mailbox server host is not allowed.");
    expect(mockedLookup).not.toHaveBeenCalled();
    expect(mockedVerifyMailboxConnection).not.toHaveBeenCalled();
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
    expect(prisma.emailConnection.create).not.toHaveBeenCalled();
    expect(prisma.emailConnection.upsert).not.toHaveBeenCalled();
  });

  it("rejects custom IPv4-mapped IPv6 loopback hosts before resolving or connecting", async () => {
    const result = await connectImapMailboxAction({
      ...customInput,
      imapHost: "::ffff:7f00:1",
    });

    expect(result?.serverError).toBe("Mailbox server host is not allowed.");
    expect(mockedLookup).not.toHaveBeenCalled();
    expect(mockedVerifyMailboxConnection).not.toHaveBeenCalled();
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
    expect(prisma.emailConnection.create).not.toHaveBeenCalled();
    expect(prisma.emailConnection.upsert).not.toHaveBeenCalled();
  });

  it("does not apply custom host checks to STRATO preset connections", async () => {
    const result = await connectStratoMailboxAction(input);

    expect(result?.serverError).toBeUndefined();
    expect(mockedLookup).not.toHaveBeenCalled();
    expect(mockedVerifyMailboxConnection).toHaveBeenCalledWith({
      imap: STRATO_IMAP_PRESET.imap,
      smtp: STRATO_IMAP_PRESET.smtp,
      username: "user@example.com",
      password: "strato-password",
    });
  });

  it("rejects a duplicate mailbox already owned by another user", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "existing-email-account",
      userId: "other-user",
      account: {
        id: "account-1",
        provider: "imap",
      },
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>);

    const result = await connectStratoMailboxAction(input);

    expect(result?.serverError).toBe(
      "Mailbox is already connected to another user.",
    );
    expect(mockedVerifyMailboxConnection).not.toHaveBeenCalled();
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
    expect(prisma.emailConnection.create).not.toHaveBeenCalled();
    expect(prisma.emailConnection.upsert).not.toHaveBeenCalled();
  });

  it("updates the same user's existing STRATO mailbox connection", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "existing-email-account",
      userId: "user-1",
      account: {
        id: "account-1",
        provider: "imap",
      },
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>);

    const result = await connectStratoMailboxAction(input);

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({
      status: "updated",
      emailAccountId: "existing-email-account",
      email: "user@example.com",
    });
    expect(mockedVerifyMailboxConnection).toHaveBeenCalledWith({
      imap: STRATO_IMAP_PRESET.imap,
      smtp: STRATO_IMAP_PRESET.smtp,
      username: "user@example.com",
      password: "strato-password",
    });
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: "account-1" },
      data: {
        provider: "imap",
        providerAccountId: "user@example.com",
        type: "imap",
        disconnectedAt: null,
      },
    });
    expect(prisma.emailConnection.upsert).toHaveBeenCalledWith({
      where: { emailAccountId: "existing-email-account" },
      create: {
        ...stratoConnectionData,
        emailAccountId: "existing-email-account",
      },
      update: stratoConnectionData,
    });
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
    expect(JSON.stringify(result?.data)).not.toContain("strato-password");
  });

  it("does not write credentials when connectivity verification fails", async () => {
    mockedVerifyMailboxConnection.mockRejectedValue(
      new SafeError(
        "IMAP authentication failed. Check the mailbox email address and password.",
      ),
    );

    const result = await connectStratoMailboxAction(input);

    expect(result?.serverError).toBe(
      "IMAP authentication failed. Check the mailbox email address and password.",
    );
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
    expect(prisma.emailConnection.create).not.toHaveBeenCalled();
    expect(prisma.emailConnection.upsert).not.toHaveBeenCalled();
  });

  it("returns validation errors without writing", async () => {
    const result = await connectStratoMailboxAction({
      email: "not-an-email",
      password: "",
    });

    expect(result?.validationErrors).toBeDefined();
    expect(result?.serverError).toBeUndefined();
    expect(mockedVerifyMailboxConnection).not.toHaveBeenCalled();
    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
    expect(prisma.emailConnection.create).not.toHaveBeenCalled();
    expect(prisma.emailConnection.upsert).not.toHaveBeenCalled();
  });
});
