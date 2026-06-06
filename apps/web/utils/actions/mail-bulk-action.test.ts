import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailAccountWithAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import {
  createAutoArchiveFilterAction,
  createFilterAction,
  deleteFilterAction,
} from "@/utils/actions/mail";
import {
  bulkArchiveAction,
  bulkTrashAction,
} from "@/utils/actions/mail-bulk-action";
import { ActionType } from "@/generated/prisma/enums";

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
  mockCreateAutoArchiveFilter,
  mockCreateFilter,
  mockDeleteFilter,
} = vi.hoisted(() => ({
  envMock: {
    NODE_ENV: "test",
  },
  mockBulkArchiveFromSenders: vi.fn(),
  mockBulkTrashFromSenders: vi.fn(),
  mockCreateEmailProvider: vi.fn(),
  mockCreateAutoArchiveFilter: vi.fn(),
  mockCreateFilter: vi.fn(),
  mockDeleteFilter: vi.fn(),
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
    mockCreateAutoArchiveFilter.mockResolvedValue({ status: 200 });
    mockCreateFilter.mockResolvedValue({ status: 200 });
    mockDeleteFilter.mockResolvedValue({ status: 200 });
    mockCreateEmailProvider.mockResolvedValue({
      bulkArchiveFromSenders: mockBulkArchiveFromSenders,
      bulkTrashFromSenders: mockBulkTrashFromSenders,
      createAutoArchiveFilter: mockCreateAutoArchiveFilter,
      createFilter: mockCreateFilter,
      deleteFilter: mockDeleteFilter,
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

  it("creates an app-side archive rule for IMAP sender cleanup without native filters", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "owner@example.com",
        userId: "user-1",
        provider: "imap",
      }),
    );
    prisma.rule.upsert.mockResolvedValue({ id: "rule-1" } as never);

    const result = await createAutoArchiveFilterAction("account-1", {
      from: "News <News@Example.com>",
    });

    expect(result?.serverError).toBeUndefined();
    expect(mockCreateEmailProvider).not.toHaveBeenCalled();
    expect(prisma.rule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          name_emailAccountId: {
            name: "Sender cleanup: news@example.com",
            emailAccountId: "account-1",
          },
        },
        create: expect.objectContaining({
          from: "news@example.com",
          actions: {
            createMany: {
              data: [
                expect.objectContaining({
                  emailAccountId: "account-1",
                  type: ActionType.ARCHIVE,
                }),
              ],
            },
          },
        }),
      }),
    );
  });

  it("creates an app-side folder rule for IMAP future sender cleanup without createFilter", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "owner@example.com",
        userId: "user-1",
        provider: "imap",
      }),
    );
    prisma.rule.upsert.mockResolvedValue({ id: "rule-1" } as never);

    const result = await createFilterAction("account-1", {
      from: "sender@example.com",
      gmailLabelId: "folder-123",
      labelName: "Newsletters",
    });

    expect(result?.serverError).toBeUndefined();
    expect(mockCreateEmailProvider).not.toHaveBeenCalled();
    expect(prisma.rule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          actions: {
            deleteMany: {},
            createMany: {
              data: [
                expect.objectContaining({
                  emailAccountId: "account-1",
                  type: ActionType.MOVE_FOLDER,
                  folderId: "folder-123",
                  folderName: "Newsletters",
                }),
              ],
            },
          },
        }),
      }),
    );
  });

  it("deletes IMAP app-side cleanup rules without deleteFilter", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "owner@example.com",
        userId: "user-1",
        provider: "imap",
      }),
    );

    const result = await deleteFilterAction("account-1", { id: "rule-1" });

    expect(result?.serverError).toBeUndefined();
    expect(mockCreateEmailProvider).not.toHaveBeenCalled();
    expect(prisma.rule.delete).toHaveBeenCalledWith({
      where: {
        id_emailAccountId: { id: "rule-1", emailAccountId: "account-1" },
      },
    });
  });

  it("deletes IMAP app-side cleanup rules by sender when no filter id is available", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "owner@example.com",
        userId: "user-1",
        provider: "imap",
      }),
    );

    const result = await deleteFilterAction("account-1", {
      from: "News <News@Example.com>",
    });

    expect(result?.serverError).toBeUndefined();
    expect(mockCreateEmailProvider).not.toHaveBeenCalled();
    expect(prisma.rule.deleteMany).toHaveBeenCalledWith({
      where: {
        emailAccountId: "account-1",
        name: "Sender cleanup: news@example.com",
      },
    });
  });

  it("keeps Gmail native filter creation unchanged", async () => {
    const result = await createFilterAction("account-1", {
      from: "sender@example.com",
      gmailLabelId: "label-123",
    });

    expect(result?.serverError).toBeUndefined();
    expect(mockCreateEmailProvider).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      provider: "google",
      logger: expect.anything(),
    });
    expect(mockCreateFilter).toHaveBeenCalledWith({
      from: "sender@example.com",
      addLabelIds: ["label-123"],
    });
    expect(prisma.rule.upsert).not.toHaveBeenCalled();
  });
});
