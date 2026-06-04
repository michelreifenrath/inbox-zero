import { afterEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("better-auth", () => ({
  betterAuth: vi.fn((options: unknown) => ({
    api: {
      getSession: vi.fn(),
    },
    options,
  })),
}));

vi.mock("@/utils/prisma");
vi.mock("@googleapis/people", () => ({
  people: vi.fn(),
}));
vi.mock("@googleapis/gmail", () => ({
  auth: {
    OAuth2: vi.fn(),
  },
}));
vi.mock("@/utils/encryption", () => ({
  encryptToken: vi.fn((token) => token),
}));

describe("betterAuthConfig login providers", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/utils/oauth/login-providers");
  });

  it("includes credentials alongside configured OAuth providers when credentials login is enabled", async () => {
    const { getEnabledLoginProviders } = await import(
      "@/utils/oauth/login-providers"
    );

    expect(
      Array.from(
        getEnabledLoginProviders({
          hasGoogleConfig: true,
          hasMicrosoftConfig: true,
          credentialsLoginEnabled: true,
        }),
      ),
    ).toEqual(["google", "microsoft", "credentials"]);
  });

  it("does not register social providers or credentials when only SSO login is enabled", async () => {
    const betterAuthConfig = await loadBetterAuthConfig(["sso"]);

    expect(betterAuthConfig.options.socialProviders).toEqual({});
    expect(betterAuthConfig.options.emailAndPassword.enabled).toBe(false);
  });

  it("registers only enabled social providers", async () => {
    const betterAuthConfig = await loadBetterAuthConfig(["apple"]);

    expect(Object.keys(betterAuthConfig.options.socialProviders)).toEqual([
      "apple",
    ]);
  });

  it("enables credentials without registering credentials as a social provider", async () => {
    const betterAuthConfig = await loadBetterAuthConfig([
      "credentials",
      "apple",
    ]);

    expect(betterAuthConfig.options.emailAndPassword.enabled).toBe(true);
    expect(Object.keys(betterAuthConfig.options.socialProviders)).toEqual([
      "apple",
    ]);
  });

  it("keeps credential accounts out of mailbox linking", async () => {
    const betterAuthConfig = await loadBetterAuthConfig(["credentials"]);

    await betterAuthConfig.options.databaseHooks.account.create.after({
      id: "account_1",
      userId: "user_1",
      providerId: "credential",
      accessToken: null,
    });

    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
    expect(prisma.emailAccount.upsert).not.toHaveBeenCalled();
  });
});

async function loadBetterAuthConfig(enabledProviders: string[]) {
  vi.resetModules();
  vi.doMock("@/utils/oauth/login-providers", () => ({
    getEnabledLoginProviders: () => new Set(enabledProviders),
  }));

  const { betterAuthConfig } = await import("@/utils/auth");

  return betterAuthConfig as any;
}
