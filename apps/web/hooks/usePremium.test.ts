// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { envMock, mockUseUser } = vi.hoisted(() => ({
  envMock: {
    NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS: false,
  },
  mockUseUser: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: envMock,
}));

vi.mock("@/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

import { usePremium } from "./usePremium";

describe("usePremium", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = false;
  });

  it("does not report AI access for a canceled Stripe trial", () => {
    mockUseUser.mockReturnValue({
      data: {
        premium: {
          tier: "STARTER_MONTHLY",
          stripeSubscriptionStatus: "canceled",
          lemonSqueezyRenewsAt: null,
          appleExpiresAt: null,
          appleRevokedAt: null,
          appleSubscriptionStatus: null,
          unsubscribeCredits: 0,
        },
        hasAiApiKey: false,
      },
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    });

    const { result } = renderHook(() => usePremium());

    expect(result.current.isPremium).toBe(false);
    expect(result.current.hasAiAccess).toBe(false);
  });

  it("preserves AI access for an active Stripe subscription", () => {
    mockUseUser.mockReturnValue({
      data: {
        premium: {
          tier: "STARTER_MONTHLY",
          stripeSubscriptionStatus: "active",
          lemonSqueezyRenewsAt: null,
          appleExpiresAt: null,
          appleRevokedAt: null,
          appleSubscriptionStatus: null,
          unsubscribeCredits: 0,
        },
        hasAiApiKey: false,
      },
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    });

    const { result } = renderHook(() => usePremium());

    expect(result.current.isPremium).toBe(true);
    expect(result.current.hasAiAccess).toBe(true);
  });

  it("uses the active admin grant tier for AI access", () => {
    mockUseUser.mockReturnValue({
      data: {
        premium: {
          tier: "BASIC_MONTHLY",
          stripeSubscriptionStatus: null,
          lemonSqueezyRenewsAt: null,
          appleExpiresAt: null,
          appleRevokedAt: null,
          appleSubscriptionStatus: null,
          adminGrantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          adminGrantTier: "STARTER_MONTHLY",
          unsubscribeCredits: 0,
        },
        hasAiApiKey: false,
      },
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    });

    const { result } = renderHook(() => usePremium());

    expect(result.current.isPremium).toBe(true);
    expect(result.current.tier).toBe("STARTER_MONTHLY");
    expect(result.current.hasAiAccess).toBe(true);
  });

  it("reports missing AI configuration when neither deployment nor user AI access is configured", () => {
    mockUseUser.mockReturnValue({
      data: {
        premium: null,
        aiProvider: null,
        hasAiApiKey: false,
        aiReadiness: {
          hasAiConfiguration: false,
          hasUserAiConfiguration: false,
          hasDeploymentAiConfiguration: false,
          needsAiConfiguration: true,
        },
      },
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    });

    const { result } = renderHook(() => usePremium());

    expect(result.current.hasAiConfiguration).toBe(false);
    expect(result.current.needsAiConfiguration).toBe(true);
  });

  it("reports present AI configuration when the user has a provider and key", () => {
    mockUseUser.mockReturnValue({
      data: {
        premium: null,
        aiProvider: "openai",
        hasAiApiKey: true,
        aiReadiness: {
          hasAiConfiguration: true,
          hasUserAiConfiguration: true,
          hasDeploymentAiConfiguration: false,
          needsAiConfiguration: false,
        },
      },
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    });

    const { result } = renderHook(() => usePremium());

    expect(result.current.hasAiConfiguration).toBe(true);
    expect(result.current.needsAiConfiguration).toBe(false);
  });
});
