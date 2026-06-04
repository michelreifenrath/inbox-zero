import { IMAP_PROVIDER } from "./provider-types";

export const STRATO_IMAP_PRESET = {
  provider: IMAP_PROVIDER,
  imap: {
    host: "imap.strato.de",
    port: 993,
    secure: true,
  },
  smtp: {
    host: "smtp.strato.de",
    port: 465,
    secure: true,
  },
  usernameBehavior: "full-email-address",
} as const;
