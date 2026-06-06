import { afterEach, describe, expect, it, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: {
    NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS: false,
  },
}));

vi.mock("@/env", () => ({
  env: envMock,
}));

import {
  getAiReadiness,
  getPremiumUserFilter,
  getUserTier,
  hasActiveAppleSubscription,
  isActivePremium,
  isPremium,
  isPremiumRecord,
} from "./index";

describe("Apple premium helpers", () => {
  afterEach(() => {
    envMock.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = false;
  });

  it("treats grace and retry states as active", () => {
    const expiredDate = new Date(Date.now() - 60_000).toISOString();

    expect(
      hasActiveAppleSubscription(expiredDate, null, "BILLING_GRACE_PERIOD"),
    ).toBe(true);
    expect(hasActiveAppleSubscription(expiredDate, null, "BILLING_RETRY")).toBe(
      true,
    );
  });

  it("treats active Apple subscriptions as premium even when the expiry is past", () => {
    const expiredDate = new Date(Date.now() - 60_000).toISOString();

    expect(isPremium(null, null, expiredDate, null, "ACTIVE")).toBe(true);
  });

  it("treats active Apple premium records as premium even when the expiry is past", () => {
    const expiredDate = new Date(Date.now() - 60_000).toISOString();

    expect(
      isPremiumRecord({
        appleExpiresAt: expiredDate,
        appleRevokedAt: null,
        appleSubscriptionStatus: "ACTIVE",
        lemonSqueezyRenewsAt: null,
        stripeSubscriptionStatus: null,
        tier: "STARTER_MONTHLY",
      }),
    ).toBe(true);
  });

  it("preserves the tier for active Apple subscriptions", () => {
    const expiredDate = new Date(Date.now() - 60_000).toISOString();

    expect(
      getUserTier({
        tier: "STARTER_MONTHLY",
        appleExpiresAt: expiredDate,
        appleRevokedAt: null,
        appleSubscriptionStatus: "ACTIVE",
        lemonSqueezyRenewsAt: null,
        stripeSubscriptionStatus: null,
      }),
    ).toBe("STARTER_MONTHLY");
  });

  it("treats active admin grants as premium", () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();

    expect(
      isPremiumRecord({
        adminGrantExpiresAt: futureDate,
        adminGrantTier: "PLUS_MONTHLY",
        lemonSqueezyRenewsAt: null,
        stripeSubscriptionStatus: null,
      }),
    ).toBe(true);
  });

  it("uses the active admin grant tier when it is higher than the processor tier", () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();

    expect(
      getUserTier({
        tier: "STARTER_MONTHLY",
        stripeSubscriptionStatus: "trialing",
        adminGrantExpiresAt: futureDate,
        adminGrantTier: "PROFESSIONAL_MONTHLY",
        lemonSqueezyRenewsAt: null,
      }),
    ).toBe("PROFESSIONAL_MONTHLY");
  });

  it("ignores expired admin grant tiers", () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();

    expect(
      getUserTier({
        tier: "STARTER_MONTHLY",
        stripeSubscriptionStatus: "active",
        adminGrantExpiresAt: pastDate,
        adminGrantTier: "PROFESSIONAL_MONTHLY",
        lemonSqueezyRenewsAt: null,
      }),
    ).toBe("STARTER_MONTHLY");
  });

  it("treats missing premium records as premium when bypass checks are enabled", () => {
    envMock.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = true;

    expect(isPremiumRecord(null)).toBe(true);
  });

  it("does not treat active processor state as premium without a tier", () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const activeProcessorRecords = [
      { stripeSubscriptionStatus: "active", tier: null },
      { lemonSqueezyRenewsAt: futureDate, tier: null },
      {
        appleExpiresAt: futureDate,
        appleRevokedAt: null,
        appleSubscriptionStatus: "ACTIVE",
        tier: null,
      },
    ];

    for (const premium of activeProcessorRecords) {
      expect(isPremiumRecord(premium)).toBe(false);
    }
  });

  it("does not treat active grant state as premium without an admin grant tier", () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();

    expect(
      isPremiumRecord({
        adminGrantExpiresAt: futureDate,
        adminGrantTier: null,
        lemonSqueezyRenewsAt: null,
        stripeSubscriptionStatus: null,
      }),
    ).toBe(false);
  });

  it("does not treat active processor state as active premium without a tier", () => {
    expect(
      isActivePremium({
        stripeSubscriptionStatus: "active",
        lemonSqueezyRenewsAt: null,
        tier: null,
      }),
    ).toBe(false);
  });
});

describe("AI readiness", () => {
  it("reports missing AI configuration without a deployment model or user key", () => {
    expect(
      getAiReadiness({
        aiProvider: null,
        hasAiApiKey: false,
        hasDeploymentAiConfiguration: false,
      }),
    ).toMatchObject({
      hasAiConfiguration: false,
      hasUserAiConfiguration: false,
      hasDeploymentAiConfiguration: false,
      needsAiConfiguration: true,
    });
  });

  it("reports AI configuration ready when the user configured a provider and key", () => {
    expect(
      getAiReadiness({
        aiProvider: "openai",
        hasAiApiKey: true,
        hasDeploymentAiConfiguration: false,
      }),
    ).toMatchObject({
      hasAiConfiguration: true,
      hasUserAiConfiguration: true,
      hasDeploymentAiConfiguration: false,
      needsAiConfiguration: false,
    });
  });

  it("reports AI configuration ready when a deployment model is configured", () => {
    expect(
      getAiReadiness({
        aiProvider: null,
        hasAiApiKey: false,
        hasDeploymentAiConfiguration: true,
      }),
    ).toMatchObject({
      hasAiConfiguration: true,
      hasUserAiConfiguration: false,
      hasDeploymentAiConfiguration: true,
      needsAiConfiguration: false,
    });
  });
});

describe("digest access", () => {
  afterEach(() => {
    envMock.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = false;
  });

  it("filters premium users by minimum tier when requested", () => {
    const filter = getPremiumUserFilter({ minimumTier: "PLUS_MONTHLY" });

    expect(filter.user.premium.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          AND: expect.arrayContaining([
            {
              tier: {
                in: [
                  "PLUS_MONTHLY",
                  "PLUS_ANNUALLY",
                  "PROFESSIONAL_MONTHLY",
                  "PROFESSIONAL_ANNUALLY",
                  "COPILOT_MONTHLY",
                  "LIFETIME",
                ],
              },
            },
          ]),
        }),
        expect.objectContaining({
          AND: expect.arrayContaining([
            {
              adminGrantTier: {
                in: [
                  "PLUS_MONTHLY",
                  "PLUS_ANNUALLY",
                  "PROFESSIONAL_MONTHLY",
                  "PROFESSIONAL_ANNUALLY",
                  "COPILOT_MONTHLY",
                  "LIFETIME",
                ],
              },
            },
          ]),
        }),
      ]),
    );
  });

  it("requires a non-null tier when filtering premium users without a minimum tier", () => {
    const filter = getPremiumUserFilter();

    expect(filter.user.premium.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          AND: expect.arrayContaining([{ tier: { not: null } }]),
        }),
        expect.objectContaining({
          AND: expect.arrayContaining([{ adminGrantTier: { not: null } }]),
        }),
      ]),
    );
  });
});
