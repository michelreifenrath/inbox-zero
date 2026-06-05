export const IMAP_PROVIDER = "imap";

const OAUTH_PROVIDERS = new Set(["google", "microsoft"]);

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

export function supportsProviderStoredDrafts(
  provider: string | null | undefined,
) {
  return isOAuthProvider(provider);
}

export function supportsProviderSignatureLookup(
  provider: string | null | undefined,
) {
  return isOAuthProvider(provider);
}

export function supportsProviderWriteActions(
  provider: string | null | undefined,
) {
  return isOAuthProvider(provider);
}

export function supportsBulkSenderActions(provider: string | null | undefined) {
  return isOAuthProvider(provider);
}
