import { env } from "@/env";
import {
  hasAppleOauthConfig,
  hasGoogleOauthConfig,
  hasMicrosoftOauthConfig,
} from "@/utils/oauth/provider-config";

export type LoginProvider =
  | "google"
  | "microsoft"
  | "apple"
  | "sso"
  | "credentials";

export function getEnabledLoginProviders(
  inputs: {
    hasGoogleConfig?: boolean;
    hasMicrosoftConfig?: boolean;
    hasAppleConfig?: boolean;
    ssoLoginEnabled?: boolean;
    credentialsLoginEnabled?: boolean;
  } = {},
): ReadonlySet<LoginProvider> {
  const {
    hasGoogleConfig = hasGoogleOauthConfig(),
    hasMicrosoftConfig = hasMicrosoftOauthConfig(),
    hasAppleConfig = hasAppleOauthConfig(),
    ssoLoginEnabled = env.SSO_LOGIN_ENABLED,
    credentialsLoginEnabled = env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS,
  } = inputs;

  const enabled = new Set<LoginProvider>();

  if (hasGoogleConfig) {
    enabled.add("google");
  }
  if (hasMicrosoftConfig) {
    enabled.add("microsoft");
  }
  if (hasAppleConfig) {
    enabled.add("apple");
  }
  if (ssoLoginEnabled) {
    enabled.add("sso");
  }
  if (credentialsLoginEnabled) {
    enabled.add("credentials");
  }

  return enabled;
}
