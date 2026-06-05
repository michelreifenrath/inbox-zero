import { describe, expect, it } from "vitest";
import {
  isGoogleProvider,
  isImapProvider,
  isMicrosoftProvider,
  isOAuthProvider,
  supportsBulkSenderActions,
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

  it("keeps provider-stored and provider-write capabilities off for IMAP", () => {
    for (const provider of ["google", "microsoft"]) {
      expect(supportsProviderStoredDrafts(provider)).toBe(true);
      expect(supportsProviderSignatureLookup(provider)).toBe(true);
      expect(supportsProviderWriteActions(provider)).toBe(true);
      expect(supportsBulkSenderActions(provider)).toBe(true);
    }

    expect(supportsProviderStoredDrafts("imap")).toBe(false);
    expect(supportsProviderSignatureLookup("imap")).toBe(false);
    expect(supportsProviderWriteActions("imap")).toBe(false);
    expect(supportsBulkSenderActions("imap")).toBe(false);
  });
});
