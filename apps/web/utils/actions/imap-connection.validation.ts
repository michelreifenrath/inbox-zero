import { z } from "zod";

const emailSchema = z
  .string()
  .trim()
  .max(320, "Email address is too long")
  .email("Please enter a valid email address")
  .transform((email) => email.toLowerCase());

const passwordSchema = z
  .string()
  .min(1, "Password is required")
  .max(1024, "Password is too long");

const hostnameSchema = z
  .string()
  .trim()
  .min(1, "Server host is required")
  .max(255, "Server host is too long");

const portSchema = z.coerce
  .number({ invalid_type_error: "Port is required" })
  .int("Port must be a whole number")
  .min(1, "Port must be between 1 and 65535")
  .max(65_535, "Port must be between 1 and 65535");

const stratoMailboxBody = z.object({
  preset: z.literal("strato"),
  email: emailSchema,
  password: passwordSchema,
});

const stratoMailboxFormBody = stratoMailboxBody.extend({
  username: z.unknown(),
  imapHost: z.unknown(),
  imapPort: z.unknown(),
  imapSecure: z.boolean(),
  smtpHost: z.unknown(),
  smtpPort: z.unknown(),
  smtpSecure: z.boolean(),
});

const customMailboxBody = z.object({
  preset: z.literal("custom"),
  email: emailSchema,
  password: passwordSchema,
  username: z
    .string()
    .trim()
    .min(1, "Username is required")
    .max(320, "Username is too long"),
  imapHost: hostnameSchema,
  imapPort: portSchema,
  imapSecure: z.boolean(),
  smtpHost: hostnameSchema,
  smtpPort: portSchema,
  smtpSecure: z.boolean(),
});

export const connectImapMailboxBody = z.discriminatedUnion("preset", [
  stratoMailboxBody,
  customMailboxBody,
]);

export const connectImapMailboxFormBody = z.discriminatedUnion("preset", [
  stratoMailboxFormBody,
  customMailboxBody,
]);

export const connectStratoMailboxBody = stratoMailboxBody.omit({
  preset: true,
});

export type ConnectImapMailboxBody = z.infer<typeof connectImapMailboxBody>;
export type ConnectImapMailboxFormBody = z.infer<
  typeof connectImapMailboxFormBody
>;
export type ConnectStratoMailboxBody = z.infer<typeof connectStratoMailboxBody>;
