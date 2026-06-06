import type { ActionType } from "@/generated/prisma/enums";

export const IMAP_PROVIDER = "imap";

const OAUTH_PROVIDERS = new Set(["google", "microsoft"]);

const PROVIDER_CAPABILITIES = {
  google: {
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
  },
  microsoft: {
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
  },
  [IMAP_PROVIDER]: {
    mailboxArchive: false,
    mailboxTrash: false,
    mailboxMarkRead: false,
    mailboxMarkUnread: false,
    mailboxStar: false,
    mailboxSpam: false,
    folderMove: false,
    folderCreate: false,
    labelActions: false,
    providerStoredDrafts: false,
    providerNativeFilters: false,
    bulkSenderActions: false,
    providerSignatureLookup: false,
  },
} as const;

type KnownProvider = keyof typeof PROVIDER_CAPABILITIES;
export type ProviderCapability = keyof (typeof PROVIDER_CAPABILITIES)["google"];

const UNKNOWN_PROVIDER_CAPABILITIES = Object.fromEntries(
  Object.keys(PROVIDER_CAPABILITIES.google).map((capability) => [
    capability,
    false,
  ]),
) as Record<ProviderCapability, boolean>;

const PROVIDER_WRITE_CAPABILITIES = [
  "mailboxArchive",
  "mailboxTrash",
  "mailboxMarkRead",
  "mailboxMarkUnread",
  "mailboxStar",
  "mailboxSpam",
  "labelActions",
] as const satisfies readonly ProviderCapability[];

const RULE_ACTION_REQUIRED_CAPABILITIES: Partial<
  Record<ActionType, ProviderCapability>
> = {
  ARCHIVE: "mailboxArchive",
  LABEL: "labelActions",
  DRAFT_EMAIL: "providerStoredDrafts",
  DRAFT_MESSAGING_CHANNEL: "providerStoredDrafts",
  MARK_SPAM: "mailboxSpam",
  MARK_READ: "mailboxMarkRead",
  STAR: "mailboxStar",
  MOVE_FOLDER: "folderMove",
};

export const IMAP_UNSUPPORTED_WRITE_FEATURE_MESSAGE =
  "This feature isn't supported for IMAP accounts because generic IMAP mailboxes are read-only in Inbox Zero.";

export const IMAP_UNSUPPORTED_DRAFT_FEATURE_MESSAGE =
  "This feature isn't supported for IMAP accounts because provider-stored drafts aren't available for generic IMAP mailboxes.";

export const IMAP_UNSUPPORTED_SIGNATURE_LOOKUP_MESSAGE =
  "Loading signatures from your mail provider isn't supported for IMAP accounts. Paste your signature manually instead.";

export function isGoogleProvider(
  provider: string | null | undefined,
): provider is "google" {
  return provider === "google";
}

export function isMicrosoftProvider(
  provider: string | null | undefined,
): provider is "microsoft" {
  return provider === "microsoft";
}

export function isImapProvider(
  provider: string | null | undefined,
): provider is typeof IMAP_PROVIDER {
  return provider === IMAP_PROVIDER;
}

export function isOAuthProvider(
  provider: string | null | undefined,
): provider is "google" | "microsoft" {
  return OAUTH_PROVIDERS.has(provider || "");
}

export function getProviderCapabilities(provider: string | null | undefined) {
  return isKnownProvider(provider)
    ? PROVIDER_CAPABILITIES[provider]
    : UNKNOWN_PROVIDER_CAPABILITIES;
}

export function supportsProviderCapability(
  provider: string | null | undefined,
  capability: ProviderCapability,
) {
  return getProviderCapabilities(provider)[capability];
}

export function supportsProviderRuleAction(
  provider: string | null | undefined,
  actionType: ActionType,
) {
  const capability = RULE_ACTION_REQUIRED_CAPABILITIES[actionType];
  return capability ? supportsProviderCapability(provider, capability) : true;
}

export function supportsProviderStoredDrafts(
  provider: string | null | undefined,
) {
  return supportsProviderCapability(provider, "providerStoredDrafts");
}

export function supportsProviderSignatureLookup(
  provider: string | null | undefined,
) {
  return supportsProviderCapability(provider, "providerSignatureLookup");
}

export function supportsProviderNativeFilters(
  provider: string | null | undefined,
) {
  return supportsProviderCapability(provider, "providerNativeFilters");
}

export function supportsProviderWriteActions(
  provider: string | null | undefined,
) {
  return PROVIDER_WRITE_CAPABILITIES.every((capability) =>
    supportsProviderCapability(provider, capability),
  );
}

export function supportsBulkSenderActions(provider: string | null | undefined) {
  return supportsProviderCapability(provider, "bulkSenderActions");
}

function isKnownProvider(
  provider: string | null | undefined,
): provider is KnownProvider {
  return provider ? provider in PROVIDER_CAPABILITIES : false;
}
