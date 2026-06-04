import { z } from "zod";

export const connectStratoMailboxBody = z.object({
  email: z
    .string()
    .trim()
    .max(320, "Email address is too long")
    .email("Please enter a valid email address")
    .transform((email) => email.toLowerCase()),
  password: z
    .string()
    .min(1, "Password is required")
    .max(1024, "Password is too long"),
});

export type ConnectStratoMailboxBody = z.infer<typeof connectStratoMailboxBody>;
