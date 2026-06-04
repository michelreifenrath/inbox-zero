import { describe, expect, it } from "vitest";
import { connectStratoMailboxBody } from "./imap-connection.validation";

const validInput = {
  email: "user@example.com",
  password: "strato-password",
};

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
      ...validInput,
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
