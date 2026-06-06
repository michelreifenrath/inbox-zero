import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailAccountWithAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import {
  bulkArchiveAction,
  bulkTrashAction,
} from "@/utils/actions/mail-bulk-action";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));

const {
  envMock,
  mockBulkArchiveFromSenders,
  mockBulkTrashFromSenders,
  mockCreateEmailProvider,
} = vi.hoisted(() => ({
  envMock: {
    NODE_ENV: "test",
  },
  mockBulkArchiveFromSenders: vi.fn(),
  mockBulkTrashFromSenders: vi.fn(),
  mockCreateEmailProvider: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: envMock,
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: (...args: Parameters<typeof mockCreateEmailProvider>) =>
    mockCreateEmailProvider(...args),
}));

describe("bulkArchiveAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "owner@example.com",
        userId: "user-1",
        provider: "google",
      }),
    );
    mockCreateEmailProvider.mockResolvedValue({
      bulkArchiveFromSenders: mockBulkArchiveFromSenders,
      bulkTrashFromSenders: mockBulkTrashFromSenders,
    });
  });

  it("archives Gmail senders directly with the provider", async () => {
    const result = await bulkArchiveAction("account-1", {
      froms: ["first@example.com", "second@example.com"],
    });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toBeUndefined();
    expect(mockCreateEmailProvider).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      provider: "google",
      logger: expect.anything(),
    });
    expect(mockBulkArchiveFromSenders).toHaveBeenCalledWith(
      ["first@example.com", "second@example.com"],
      "owner@example.com",
      "account-1",
    );
  });

  it("archives Outlook senders directly with the provider", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "owner@example.com",
        userId: "user-1",
        provider: "microsoft",
      }),
    );

    const result = await bulkArchiveAction("account-1", {
      froms: ["sender@example.com"],
    });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toBeUndefined();
    expect(mockCreateEmailProvider).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      provider: "microsoft",
      logger: expect.anything(),
    });
    expect(mockBulkArchiveFromSenders).toHaveBeenCalledWith(
      ["sender@example.com"],
      "owner@example.com",
      "account-1",
    );
  });

  it("archives IMAP senders directly with the provider", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "owner@example.com",
        userId: "user-1",
        provider: "imap",
      }),
    );

    const result = await bulkArchiveAction("account-1", {
      froms: ["sender@example.com"],
    });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toBeUndefined();
    expect(mockCreateEmailProvider).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      provider: "imap",
      logger: expect.anything(),
    });
    expect(mockBulkArchiveFromSenders).toHaveBeenCalledWith(
      ["sender@example.com"],
      "owner@example.com",
      "account-1",
    );
  });

  it("trashes IMAP senders directly with the provider", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "owner@example.com",
        userId: "user-1",
        provider: "imap",
      }),
    );

    const result = await bulkTrashAction("account-1", {
      froms: ["sender@example.com"],
    });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toBeUndefined();
    expect(mockCreateEmailProvider).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      provider: "imap",
      logger: expect.anything(),
    });
    expect(mockBulkTrashFromSenders).toHaveBeenCalledWith(
      ["sender@example.com"],
      "owner@example.com",
      "account-1",
    );
  });
});
