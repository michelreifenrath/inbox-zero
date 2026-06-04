/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseSearchParams = vi.fn();
const mockSignInWithOauth2 = vi.fn();
const mockSignInSocial = vi.fn();
const mockSignInEmail = vi.fn();
const mockSignUpEmail = vi.fn();
const mockToastError = vi.fn();
const mockRedirectToSafeUrl = vi.fn();

(globalThis as { React?: typeof React }).React = React;

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockUseSearchParams(),
}));

vi.mock("next/image", () => ({
  default: ({
    unoptimized: _unoptimized,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) => (
    // biome-ignore lint/performance/noImgElement: test-only mock
    <img
      {...props}
      alt={props.alt || ""}
      width={Number(props.width) || 1}
      height={Number(props.height) || 1}
    />
  ),
}));

vi.mock("@/utils/auth-client", () => ({
  signInWithOauth2: (...args: Parameters<typeof mockSignInWithOauth2>) =>
    mockSignInWithOauth2(...args),
  signIn: {
    social: (...args: Parameters<typeof mockSignInSocial>) =>
      mockSignInSocial(...args),
    email: (...args: Parameters<typeof mockSignInEmail>) =>
      mockSignInEmail(...args),
  },
  signUp: {
    email: (...args: Parameters<typeof mockSignUpEmail>) =>
      mockSignUpEmail(...args),
  },
}));

vi.mock("@/components/Toast", () => ({
  toastError: (...args: Parameters<typeof mockToastError>) =>
    mockToastError(...args),
}));

vi.mock("@/utils/redirect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/redirect")>();
  return {
    ...actual,
    redirectToSafeUrl: (...args: Parameters<typeof mockRedirectToSafeUrl>) =>
      mockRedirectToSafeUrl(...args),
  };
});

import { LoginForm } from "@/app/(landing)/login/LoginForm";

describe("LoginForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSearchParams.mockReturnValue({
      get: () => null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("places Apple after Google and Microsoft when all OAuth options are shown", () => {
    render(
      <LoginForm
        enabledProviders={["google", "microsoft", "apple", "sso"]}
        useGoogleOauthEmulator
      />,
    );

    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual([
      "Sign in with Google",
      "Sign in with Microsoft",
      "Sign in with Apple",
    ]);
  });

  it("signs in with email when credentials login is shown", async () => {
    mockSignInEmail.mockResolvedValue({ data: {}, error: null });

    render(
      <LoginForm enabledProviders={["credentials"]} useGoogleOauthEmulator />,
    );

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "password123" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /sign in with email/i }),
    );

    await waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledWith({
        email: "user@example.com",
        password: "password123",
        callbackURL: "/welcome-redirect",
      });
    });
    expect(mockRedirectToSafeUrl).toHaveBeenCalledWith("/welcome-redirect");
  });

  it("signs up with email when credentials login is shown", async () => {
    mockSignUpEmail.mockResolvedValue({ data: {}, error: null });

    render(
      <LoginForm enabledProviders={["credentials"]} useGoogleOauthEmulator />,
    );

    fireEvent.click(screen.getByRole("button", { name: /create an account/i }));
    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: "Self Hosted User" },
    });
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "password123" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /sign up with email/i }),
    );

    await waitFor(() => {
      expect(mockSignUpEmail).toHaveBeenCalledWith({
        name: "Self Hosted User",
        email: "user@example.com",
        password: "password123",
        callbackURL: "/welcome-redirect",
      });
    });
    expect(mockRedirectToSafeUrl).toHaveBeenCalledWith("/welcome-redirect");
  });

  it("starts Apple sign-in when the Apple option is shown", async () => {
    mockSignInSocial.mockResolvedValue(undefined);

    render(<LoginForm enabledProviders={["apple"]} useGoogleOauthEmulator />);

    fireEvent.click(
      screen.getByRole("button", { name: /sign in with apple/i }),
    );

    await waitFor(() => {
      expect(mockSignInSocial).toHaveBeenCalledWith({
        provider: "apple",
        callbackURL: "/connect-mailbox?next=%2Fwelcome-redirect",
        errorCallbackURL: "/login/error",
      });
    });
  });

  it("preserves next path for Apple sign-in", async () => {
    mockUseSearchParams.mockReturnValue({
      get: (key: string) =>
        key === "next" ? "/organizations/invitations/invite_123/accept" : null,
    });
    mockSignInSocial.mockResolvedValue(undefined);

    render(<LoginForm enabledProviders={["apple"]} useGoogleOauthEmulator />);

    fireEvent.click(
      screen.getByRole("button", { name: /sign in with apple/i }),
    );

    await waitFor(() => {
      expect(mockSignInSocial).toHaveBeenCalledWith({
        provider: "apple",
        callbackURL:
          "/connect-mailbox?next=%2Forganizations%2Finvitations%2Finvite_123%2Faccept",
        errorCallbackURL: "/login/error?reason=org_invite",
      });
    });
  });
});
