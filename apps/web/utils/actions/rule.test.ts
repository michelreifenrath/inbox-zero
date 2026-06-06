import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionType, SystemType } from "@/generated/prisma/enums";
import { ConditionType } from "@/utils/config";

const { createEmailProviderMock, createRuleHistoryMock, setRuleEnabledMock } =
  vi.hoisted(() => ({
    createEmailProviderMock: vi.fn(),
    createRuleHistoryMock: vi.fn(),
    setRuleEnabledMock: vi.fn(),
  }));

vi.mock("@/utils/rule/rule", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/rule/rule")>();
  return {
    ...actual,
    setRuleEnabled: setRuleEnabledMock,
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: createEmailProviderMock,
}));
vi.mock("@/utils/rule/rule-history", () => ({
  createRuleHistory: createRuleHistoryMock,
}));
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", email: "owner@example.com" } })),
}));

import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import {
  copyRulesFromAccountAction,
  createRulesOnboardingAction,
  deleteRuleAction,
  enableDraftRepliesAction,
  importRulesAction,
  updateRuleAction,
} from "@/utils/actions/rule";

describe("enableDraftRepliesAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createEmailProvider).mockResolvedValue({} as any);
  });

  it("re-enables the existing to-reply rule before adding draft actions", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });

    prisma.rule.findUnique.mockResolvedValue({
      id: "rule-1",
      enabled: false,
      systemType: SystemType.TO_REPLY,
      actions: [],
    } as never);

    setRuleEnabledMock.mockResolvedValue({
      id: "rule-1",
      enabled: true,
      actions: [],
    });

    await enableDraftRepliesAction("ea_1" as never, { enable: true } as never);

    expect(setRuleEnabledMock).toHaveBeenCalledWith({
      ruleId: "rule-1",
      emailAccountId: "ea_1",
      enabled: true,
    });
    expect(prisma.action.create).toHaveBeenCalledWith({
      data: {
        emailAccountId: "ea_1",
        messagingChannelEmailAccountId: null,
        ruleId: "rule-1",
        type: ActionType.DRAFT_EMAIL,
      },
    });
  });

  it("disables the existing to-reply rule when draft replies are turned off", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });

    prisma.rule.findUnique.mockResolvedValue({
      id: "rule-1",
      enabled: true,
      systemType: SystemType.TO_REPLY,
      actions: [{ type: ActionType.DRAFT_EMAIL }],
    } as never);

    setRuleEnabledMock.mockResolvedValue({
      id: "rule-1",
      enabled: false,
      actions: [{ type: ActionType.DRAFT_EMAIL }],
    });

    await enableDraftRepliesAction("ea_1" as never, { enable: false } as never);

    expect(setRuleEnabledMock).toHaveBeenCalledWith({
      ruleId: "rule-1",
      emailAccountId: "ea_1",
      enabled: false,
    });
    expect(prisma.action.deleteMany).toHaveBeenCalledWith({
      where: {
        ruleId: "rule-1",
        type: ActionType.DRAFT_EMAIL,
      },
    });
  });
});

describe("deleteRuleAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createEmailProvider).mockResolvedValue({} as any);
  });

  it("rejects deleting default rules", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });

    prisma.rule.findUnique.mockResolvedValue({
      id: "rule-1",
      emailAccountId: "ea_1",
      systemType: SystemType.NEWSLETTER,
      groupId: null,
    } as never);

    const result = await deleteRuleAction(
      "ea_1" as never,
      {
        id: "rule-1",
      } as never,
    );

    expect(result?.serverError).toBe(
      "Default rules cannot be deleted. Disable them instead.",
    );
    expect(prisma.rule.delete).not.toHaveBeenCalled();
    expect(prisma.group.deleteMany).not.toHaveBeenCalled();
  });
});

describe("updateRuleAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createEmailProvider).mockResolvedValue({} as any);
    prisma.rule.findMany.mockResolvedValue([]);
  });

  it("scopes the rule update to the bound email account", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });

    prisma.rule.update.mockResolvedValue({
      id: "victim-rule",
      actions: [],
      group: null,
    } as never);

    const result = await updateRuleAction(
      "attacker-account" as never,
      {
        id: "victim-rule",
        name: "Updated rule",
        instructions: null,
        groupId: null,
        runOnThreads: true,
        digest: false,
        actions: [
          {
            type: ActionType.ARCHIVE,
            messagingChannelId: null,
            labelId: null,
            subject: null,
            content: null,
            to: null,
            cc: null,
            bcc: null,
            url: null,
            folderName: null,
            folderId: null,
            delayInMinutes: null,
          },
        ],
        conditions: [
          {
            type: ConditionType.STATIC,
            instructions: null,
            to: null,
            from: "sender@example.com",
            subject: null,
            body: null,
          },
        ],
        conditionalOperator: "AND",
        systemType: null,
      } as never,
    );

    expect(result?.serverError).toBeUndefined();
    expect(prisma.rule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "victim-rule",
          emailAccountId: "attacker-account",
        },
      }),
    );
  });

  it("rejects unsupported IMAP provider-write actions before creating a provider", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "imap" },
    });

    const result = await updateRuleAction(
      "account-1" as never,
      {
        id: "rule-1",
        name: "Updated rule",
        instructions: null,
        groupId: null,
        runOnThreads: true,
        digest: false,
        actions: [
          {
            type: ActionType.LABEL,
            messagingChannelId: null,
            labelId: { name: "Needs Review", value: null },
            subject: null,
            content: null,
            to: null,
            cc: null,
            bcc: null,
            url: null,
            folderName: null,
            folderId: null,
            delayInMinutes: null,
          },
        ],
        conditions: [
          {
            type: ConditionType.STATIC,
            instructions: null,
            to: null,
            from: "sender@example.com",
            subject: null,
            body: null,
          },
        ],
        conditionalOperator: "AND",
        systemType: null,
      } as never,
    );

    expect(result?.serverError).toContain("isn't supported for IMAP accounts");
    expect(createEmailProviderMock).not.toHaveBeenCalled();
    expect(prisma.rule.update).not.toHaveBeenCalled();
  });
});

describe("createRulesOnboardingAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects IMAP onboarding label actions before changing rules", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "imap" },
    });

    const result = await createRulesOnboardingAction(
      "account-1" as never,
      [
        {
          name: SystemType.NEWSLETTER,
          description: "",
          key: SystemType.NEWSLETTER,
          action: "label",
        },
      ] as never,
    );

    expect(result?.serverError).toContain("isn't supported for IMAP accounts");
    expect(createEmailProviderMock).not.toHaveBeenCalled();
    expect(prisma.rule.create).not.toHaveBeenCalled();
    expect(prisma.rule.update).not.toHaveBeenCalled();
    expect(prisma.rule.delete).not.toHaveBeenCalled();
  });

  it("creates IMAP onboarding system rules with folder moves", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: "account-1",
      userId: "u1",
      email: "owner@example.com",
      account: { userId: "u1", provider: "imap" },
      user: {},
    });
    prisma.rule.findFirst.mockResolvedValue(null);
    prisma.rule.findMany.mockResolvedValue([]);
    prisma.rule.create.mockResolvedValue({
      id: "rule-newsletter",
      name: "Newsletter",
      actions: [{ type: ActionType.MOVE_FOLDER }],
      group: null,
    } as never);
    vi.mocked(createEmailProvider).mockResolvedValue({
      getOrCreateFolderIdByName: vi.fn(
        async (folderName: string) => folderName,
      ),
    } as any);

    const result = await createRulesOnboardingAction(
      "account-1" as never,
      [
        {
          name: SystemType.NEWSLETTER,
          description: "",
          key: SystemType.NEWSLETTER,
          action: "move_folder",
        },
      ] as never,
    );

    expect(result?.serverError).toBeUndefined();
    expect(prisma.rule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Newsletter",
          actions: {
            createMany: {
              data: [
                expect.objectContaining({
                  type: ActionType.MOVE_FOLDER,
                  folderName: "Newsletter",
                  folderId: "Newsletter",
                }),
              ],
            },
          },
        }),
      }),
    );
  });
});

describe("copyRulesFromAccountAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects copied write actions for IMAP targets before changing rules", async () => {
    prisma.emailAccount.findUnique
      .mockResolvedValueOnce({
        id: "source-account",
        email: "source@example.com",
        account: { userId: "u1", provider: "google" },
      } as never)
      .mockResolvedValueOnce({
        id: "target-account",
        email: "target@example.com",
        account: { userId: "u1", provider: "imap" },
      } as never);
    prisma.rule.findMany.mockResolvedValueOnce([
      {
        id: "rule-1",
        actions: [{ type: ActionType.LABEL }],
      },
    ] as never);

    const result = await copyRulesFromAccountAction({
      sourceEmailAccountId: "source-account",
      targetEmailAccountId: "target-account",
      ruleIds: ["rule-1"],
    } as never);

    expect(result?.serverError).toContain("isn't supported for IMAP accounts");
    expect(prisma.rule.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.rule.create).not.toHaveBeenCalled();
    expect(prisma.rule.update).not.toHaveBeenCalled();
  });
});

describe("importRulesAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects imported write actions for IMAP accounts before changing rules", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "imap" },
    });

    const result = await importRulesAction(
      "account-1" as never,
      {
        rules: [
          {
            name: "Imported label rule",
            instructions: "Label matching mail",
            enabled: true,
            automate: true,
            runOnThreads: false,
            conditionalOperator: "AND",
            categoryFilterType: null,
            systemType: null,
            from: null,
            to: null,
            subject: null,
            body: null,
            actions: [
              {
                type: ActionType.LABEL,
                label: "Imported",
                labelId: null,
                subject: null,
                content: null,
                to: null,
                cc: null,
                bcc: null,
                folderName: null,
                folderId: null,
                url: null,
                delayInMinutes: null,
              },
            ],
          },
        ],
      } as never,
    );

    expect(result?.serverError).toContain("isn't supported for IMAP accounts");
    expect(prisma.rule.findMany).not.toHaveBeenCalled();
    expect(prisma.rule.create).not.toHaveBeenCalled();
    expect(prisma.rule.update).not.toHaveBeenCalled();
  });
});
