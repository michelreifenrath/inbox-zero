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

const optionalHostnameSchema = z
  .string()
  .trim()
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

export const connectImapMailboxFormBody = z
  .object({
    preset: z.enum(["strato", "custom"]),
    email: emailSchema,
    password: passwordSchema,
    username: z.string().trim().max(320, "Username is too long"),
    imapHost: optionalHostnameSchema,
    imapPort: portSchema,
    imapSecure: z.boolean(),
    smtpHost: optionalHostnameSchema,
    smtpPort: portSchema,
    smtpSecure: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.preset === "strato") return;

    if (!value.username) {
      ctx.addIssue({
        code: "custom",
        message: "Username is required",
        path: ["username"],
      });
    }
    if (!value.imapHost) {
      ctx.addIssue({
        code: "custom",
        message: "Server host is required",
        path: ["imapHost"],
      });
    }
    if (!value.smtpHost) {
      ctx.addIssue({
        code: "custom",
        message: "Server host is required",
        path: ["smtpHost"],
      });
    }
  });

export const connectStratoMailboxBody = stratoMailboxBody.omit({
  preset: true,
});

export type ConnectImapMailboxBody = z.infer<typeof connectImapMailboxBody>;
export type ConnectImapMailboxFormBody = z.infer<
  typeof connectImapMailboxFormBody
>;
export type ConnectStratoMailboxBody = z.infer<typeof connectStratoMailboxBody>;
