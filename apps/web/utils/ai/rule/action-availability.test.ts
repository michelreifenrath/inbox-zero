import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import {
  getAvailableActionsForRuleEditor,
  getExtraAvailableActionsForRuleEditor,
} from "./action-availability";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    emailSendEnabled: true,
    autoDraftDisabled: false,
    webhookActionsEnabled: true,
  },
}));

vi.mock("@/env", () => ({
  env: {
    get NEXT_PUBLIC_EMAIL_SEND_ENABLED() {
      return mockEnv.emailSendEnabled;
    },
    get NEXT_PUBLIC_AUTO_DRAFT_DISABLED() {
      return mockEnv.autoDraftDisabled;
    },
    get NEXT_PUBLIC_WEBHOOK_ACTION_ENABLED() {
      return mockEnv.webhookActionsEnabled;
    },
  },
}));

describe("getAvailableActionsForRuleEditor", () => {
  beforeEach(() => {
    mockEnv.emailSendEnabled = true;
    mockEnv.autoDraftDisabled = false;
    mockEnv.webhookActionsEnabled = true;
  });

  it("preserves move folder for existing Microsoft-only actions", () => {
    const actions = getAvailableActionsForRuleEditor({
      provider: "",
      existingActionTypes: [ActionType.MOVE_FOLDER],
    });

    expect(actions).toContain(ActionType.MOVE_FOLDER);
  });

  it("keeps only persisted send actions when email sending is disabled", () => {
    mockEnv.emailSendEnabled = false;

    const actions = getAvailableActionsForRuleEditor({
      provider: "google",
      existingActionTypes: [ActionType.REPLY],
    });

    expect(actions).toContain(ActionType.REPLY);
    expect(actions).not.toContain(ActionType.SEND_EMAIL);
    expect(actions).not.toContain(ActionType.FORWARD);
  });

  it("normalizes persisted messaging drafts to the shared draft reply option", () => {
    mockEnv.autoDraftDisabled = true;

    const actions = getAvailableActionsForRuleEditor({
      provider: "google",
      existingActionTypes: [ActionType.DRAFT_MESSAGING_CHANNEL],
    });

    expect(actions).toContain(ActionType.DRAFT_EMAIL);
    expect(actions).not.toContain(ActionType.DRAFT_MESSAGING_CHANNEL);
  });

  it("keeps folder-backed rule actions Microsoft-only", () => {
    expect(
      getAvailableActionsForRuleEditor({ provider: "google" }),
    ).not.toContain(ActionType.MOVE_FOLDER);
    expect(
      getAvailableActionsForRuleEditor({ provider: "microsoft" }),
    ).toContain(ActionType.MOVE_FOLDER);
  });

  it("exposes only implemented IMAP rule actions plus SMTP send actions", () => {
    const actions = getAvailableActionsForRuleEditor({
      provider: "imap",
    });

    expect(actions).toEqual([
      ActionType.ARCHIVE,
      ActionType.MARK_READ,
      ActionType.STAR,
      ActionType.REPLY,
      ActionType.FORWARD,
      ActionType.SEND_EMAIL,
    ]);
  });
});

describe("getExtraAvailableActionsForRuleEditor", () => {
  beforeEach(() => {
    mockEnv.emailSendEnabled = true;
    mockEnv.autoDraftDisabled = false;
    mockEnv.webhookActionsEnabled = true;
  });

  it("hides webhook actions when the feature is disabled", () => {
    mockEnv.webhookActionsEnabled = false;

    const actions = getExtraAvailableActionsForRuleEditor();

    expect(actions).not.toContain(ActionType.CALL_WEBHOOK);
  });

  it("includes webhook actions when the feature is enabled", () => {
    mockEnv.webhookActionsEnabled = true;

    const actions = getExtraAvailableActionsForRuleEditor();

    expect(actions).toContain(ActionType.CALL_WEBHOOK);
  });
});
