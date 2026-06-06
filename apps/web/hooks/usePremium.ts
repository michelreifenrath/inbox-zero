"use client";

import { env } from "@/env";
import { useUser } from "@/hooks/useUser";
import {
  getAiReadiness,
  getUserTier,
  hasAiAccess,
  hasUnsubscribeAccess,
  isPremiumRecord,
} from "@/utils/premium";

export function usePremium() {
  const swrResponse = useUser();
  const { data } = swrResponse;

  const premium = data?.premium;
  const hasAiApiKey = data?.hasAiApiKey;
  const aiReadiness = getAiReadiness({
    aiProvider: data?.aiProvider,
    hasAiApiKey,
    hasDeploymentAiConfiguration:
      data?.aiReadiness?.hasDeploymentAiConfiguration,
  });

  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) {
    return {
      ...swrResponse,
      premium,
      isPremium: true,
      hasUnsubscribeAccess: true,
      hasAiAccess: true,
      aiReadiness,
      hasAiConfiguration: aiReadiness.hasAiConfiguration,
      needsAiConfiguration: aiReadiness.needsAiConfiguration,
      isProPlanWithoutApiKey: false,
      tier: "PROFESSIONAL_ANNUALLY" as const,
    };
  }

  const isUserPremium = isPremiumRecord(premium);
  const tier = getUserTier(premium);

  const isProPlanWithoutApiKey =
    (tier === "PRO_MONTHLY" || tier === "PRO_ANNUALLY") && !hasAiApiKey;

  return {
    ...swrResponse,
    premium,
    isPremium: isUserPremium,
    hasUnsubscribeAccess:
      isUserPremium ||
      hasUnsubscribeAccess(tier || null, premium?.unsubscribeCredits),
    hasAiAccess: isUserPremium && hasAiAccess(tier || null, hasAiApiKey),
    aiReadiness,
    hasAiConfiguration: aiReadiness.hasAiConfiguration,
    needsAiConfiguration: aiReadiness.needsAiConfiguration,
    isProPlanWithoutApiKey,
    tier,
  };
}
