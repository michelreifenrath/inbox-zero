import { describe, expect, it } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import {
  getProviderCapabilities,
  isGoogleProvider,
  isImapProvider,
  isMicrosoftProvider,
  isOAuthProvider,
  supportsBulkSenderActions,
  supportsProviderCapability,
  supportsProviderRuleAction,
  supportsProviderSignatureLookup,
  supportsProviderStoredDrafts,
  supportsProviderWriteActions,
} from "./provider-types";

describe("email provider identity helpers", () => {
  it("matches only the Google provider", () => {
    expect(isGoogleProvider("google")).toBe(true);
    expect(isGoogleProvider("microsoft")).toBe(false);
    expect(isGoogleProvider("imap")).toBe(false);
    expect(isGoogleProvider(null)).toBe(false);
    expect(isGoogleProvider(undefined)).toBe(false);
  });

  it("matches only the Microsoft provider", () => {
    expect(isMicrosoftProvider("microsoft")).toBe(true);
    expect(isMicrosoftProvider("google")).toBe(false);
    expect(isMicrosoftProvider("imap")).toBe(false);
    expect(isMicrosoftProvider(null)).toBe(false);
    expect(isMicrosoftProvider(undefined)).toBe(false);
  });

  it("matches only the generic IMAP provider", () => {
    expect(isImapProvider("imap")).toBe(true);
    expect(isImapProvider("google")).toBe(false);
    expect(isImapProvider("microsoft")).toBe(false);
    expect(isImapProvider(null)).toBe(false);
    expect(isImapProvider(undefined)).toBe(false);
  });

  it("groups Google and Microsoft as OAuth providers", () => {
    expect(isOAuthProvider("google")).toBe(true);
    expect(isOAuthProvider("microsoft")).toBe(true);
    expect(isOAuthProvider("imap")).toBe(false);
    expect(isOAuthProvider(null)).toBe(false);
    expect(isOAuthProvider(undefined)).toBe(false);
  });

  it("keeps provider-stored draft support on and full provider-write capabilities off for IMAP", () => {
    for (const provider of ["google", "microsoft"]) {
      expect(supportsProviderStoredDrafts(provider)).toBe(true);
      expect(supportsProviderSignatureLookup(provider)).toBe(true);
      expect(supportsProviderWriteActions(provider)).toBe(true);
      expect(supportsBulkSenderActions(provider)).toBe(true);
    }

    expect(supportsProviderStoredDrafts("imap")).toBe(true);
    expect(supportsProviderSignatureLookup("imap")).toBe(false);
    expect(supportsProviderWriteActions("imap")).toBe(false);
    expect(supportsBulkSenderActions("imap")).toBe(true);
  });

  it("exposes granular provider capabilities for OAuth providers and IMAP", () => {
    expect(getProviderCapabilities("google")).toMatchObject({
      mailboxArchive: true,
      mailboxTrash: true,
      mailboxMarkRead: true,
      mailboxMarkUnread: true,
      mailboxStar: true,
      mailboxSpam: true,
      folderMove: false,
      folderCreate: false,
      labelActions: true,
      providerStoredDrafts: true,
      providerNativeFilters: true,
      bulkSenderActions: true,
      providerSignatureLookup: true,
    });
    expect(getProviderCapabilities("microsoft")).toMatchObject({
      mailboxArchive: true,
      mailboxTrash: true,
      mailboxMarkRead: true,
      mailboxMarkUnread: true,
      mailboxStar: true,
      mailboxSpam: true,
      folderMove: true,
      folderCreate: true,
      labelActions: true,
      providerStoredDrafts: true,
      providerNativeFilters: true,
      bulkSenderActions: true,
      providerSignatureLookup: true,
    });
    expect(getProviderCapabilities("imap")).toMatchObject({
      mailboxArchive: true,
      mailboxTrash: true,
      mailboxMarkRead: true,
      mailboxMarkUnread: false,
      mailboxStar: true,
      mailboxSpam: false,
      folderMove: true,
      folderCreate: true,
      labelActions: false,
      providerStoredDrafts: true,
      providerNativeFilters: false,
      bulkSenderActions: true,
      providerSignatureLookup: false,
    });
  });

  it("checks rule actions against granular provider capabilities", () => {
    expect(supportsProviderRuleAction("google", ActionType.LABEL)).toBe(true);
    expect(supportsProviderRuleAction("google", ActionType.MOVE_FOLDER)).toBe(
      false,
    );
    expect(
      supportsProviderRuleAction("microsoft", ActionType.MOVE_FOLDER),
    ).toBe(true);
    expect(supportsProviderRuleAction("imap", ActionType.ARCHIVE)).toBe(true);
    expect(supportsProviderRuleAction("imap", ActionType.MARK_READ)).toBe(true);
    expect(supportsProviderRuleAction("imap", ActionType.STAR)).toBe(true);
    expect(supportsProviderRuleAction("imap", ActionType.LABEL)).toBe(false);
    expect(supportsProviderRuleAction("imap", ActionType.MOVE_FOLDER)).toBe(
      true,
    );
    expect(supportsProviderRuleAction("google", ActionType.DRAFT_EMAIL)).toBe(
      true,
    );
    expect(
      supportsProviderRuleAction("google", ActionType.DRAFT_MESSAGING_CHANNEL),
    ).toBe(true);
    expect(supportsProviderRuleAction("imap", ActionType.DRAFT_EMAIL)).toBe(
      true,
    );
    expect(
      supportsProviderRuleAction("imap", ActionType.DRAFT_MESSAGING_CHANNEL),
    ).toBe(true);
    expect(supportsProviderRuleAction("imap", ActionType.SEND_EMAIL)).toBe(
      true,
    );
    expect(supportsProviderRuleAction("imap", ActionType.MARK_SPAM)).toBe(
      false,
    );
    expect(supportsProviderCapability("imap", "providerNativeFilters")).toBe(
      false,
    );
  });
});
