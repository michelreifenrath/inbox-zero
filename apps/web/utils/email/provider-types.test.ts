import { describe, expect, it } from "vitest";
import {
  isGoogleProvider,
  isImapProvider,
  isMicrosoftProvider,
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
});
