import { describe, expect, it } from "vitest";
import {
  connectImapMailboxBody,
  connectImapMailboxFormBody,
  connectStratoMailboxBody,
} from "./imap-connection.validation";

const validStratoInput = {
  preset: "strato" as const,
  email: "user@example.com",
  password: "strato-password",
};

const validCustomInput = {
  preset: "custom" as const,
  email: "user@example.com",
  password: "custom-password",
  username: "mail-user",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecure: false,
};

describe("connectImapMailboxBody", () => {
  it("normalizes valid STRATO mailbox input without requiring custom fields", () => {
    const result = connectImapMailboxBody.parse({
      preset: "strato",
      email: " User@Example.COM ",
      password: "strato-password",
    });

    expect(result).toEqual(validStratoInput);
  });

  it("normalizes valid custom IMAP/SMTP input", () => {
    const result = connectImapMailboxBody.parse({
      ...validCustomInput,
      email: " User@Example.COM ",
      username: " mail-user ",
      imapHost: " imap.example.com ",
      smtpHost: " smtp.example.com ",
    });

    expect(result).toEqual(validCustomInput);
  });

  it("returns user-safe validation errors for custom IMAP/SMTP fields", () => {
    const result = connectImapMailboxBody.safeParse({
      ...validCustomInput,
      email: "not-an-email",
      password: "",
      username: "",
      imapHost: "",
      imapPort: 0,
      smtpHost: "",
      smtpPort: 70_000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors).toEqual({
        email: ["Please enter a valid email address"],
        password: ["Password is required"],
        username: ["Username is required"],
        imapHost: ["Server host is required"],
        imapPort: ["Port must be between 1 and 65535"],
        smtpHost: ["Server host is required"],
        smtpPort: ["Port must be between 1 and 65535"],
      });
    }
  });
});

describe("connectImapMailboxFormBody", () => {
  it("does not require custom fields for the STRATO preset", () => {
    const result = connectImapMailboxFormBody.safeParse({
      ...validStratoInput,
      username: "",
      imapHost: "",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "",
      smtpPort: 465,
      smtpSecure: true,
    });

    expect(result.success).toBe(true);
  });

  it("does not validate hidden custom port values for the STRATO preset", () => {
    const result = connectImapMailboxFormBody.safeParse({
      ...validStratoInput,
      username: "",
      imapHost: "",
      imapPort: 0,
      imapSecure: true,
      smtpHost: "",
      smtpPort: Number.NaN,
      smtpSecure: true,
    });

    expect(result.success).toBe(true);
  });
});

describe("connectStratoMailboxBody", () => {
  it("normalizes valid STRATO mailbox input", () => {
    const result = connectStratoMailboxBody.parse({
      email: " User@Example.COM ",
      password: "strato-password",
    });

    expect(result).toEqual({
      email: "user@example.com",
      password: "strato-password",
    });
  });

  it("returns user-safe validation errors", () => {
    const result = connectStratoMailboxBody.safeParse({
      email: "not-an-email",
      password: "",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors).toEqual({
        email: ["Please enter a valid email address"],
        password: ["Password is required"],
      });
    }
  });
});
