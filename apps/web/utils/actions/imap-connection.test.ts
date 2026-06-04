import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { STRATO_IMAP_PRESET } from "@/utils/email/imap-presets";
import { connectStratoMailboxAction } from "./imap-connection";

vi.mock("@/utils/prisma");
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

describe("connectStratoMailboxAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("returns validation errors without writing", async () => {
    const result = await connectStratoMailboxAction({
      email: "not-an-email",
      password: "",
    });

    expect(result?.validationErrors).toBeDefined();
    expect(result?.serverError).toBeUndefined();
    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
    expect(prisma.emailConnection.create).not.toHaveBeenCalled();
    expect(prisma.emailConnection.upsert).not.toHaveBeenCalled();
  });
});
