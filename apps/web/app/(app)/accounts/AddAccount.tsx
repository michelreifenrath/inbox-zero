"use client";

import Image from "next/image";
import { useState } from "react";
import type { ReactNode } from "react";
import { ImapMailboxForm } from "@/app/(app)/accounts/ImapMailboxForm";
import { toastError } from "@/components/Toast";
import { MutedText } from "@/components/Typography";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/utils";
import { getAccountLinkingUrl } from "@/utils/account-linking";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { redirectToSafeUrl } from "@/utils/redirect";

export function AddAccount({
  helperText = "You will be billed for each account.",
  className,
  onMailboxConnected,
  redirectPath,
}: {
  helperText?: ReactNode;
  className?: string;
  onMailboxConnected?: () => void | Promise<void>;
  redirectPath?: string;
}) {
  const [isLoadingGoogle, setIsLoadingGoogle] = useState(false);
  const [isLoadingMicrosoft, setIsLoadingMicrosoft] = useState(false);

  const handleAddAccount = async (provider: "google" | "microsoft") => {
    const setLoading = isGoogleProvider(provider)
      ? setIsLoadingGoogle
      : setIsLoadingMicrosoft;
    setLoading(true);

    try {
      const url = await getAccountLinkingUrl(provider);
      redirectToSafeUrl(url, { allowExternal: true });
    } catch (error) {
      console.error(`Error initiating ${provider} link:`, error);
      toastError({
        title: `Error initiating ${isGoogleProvider(provider) ? "Google" : "Microsoft"} link`,
        description: "Please try again or contact support",
      });
      setLoading(false);
    }
  };

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <CardTitle>Add mailbox</CardTitle>
        <CardDescription>
          Connect Google or Microsoft with OAuth, or use STRATO/custom IMAP.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => handleAddAccount("google")}
              loading={isLoadingGoogle}
              disabled={isLoadingGoogle || isLoadingMicrosoft}
            >
              <Image
                src="/images/google.svg"
                alt=""
                width={24}
                height={24}
                unoptimized
              />
              <span className="ml-2">Connect Google</span>
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => handleAddAccount("microsoft")}
              loading={isLoadingMicrosoft}
              disabled={isLoadingGoogle || isLoadingMicrosoft}
            >
              <Image
                src="/images/microsoft.svg"
                alt=""
                width={24}
                height={24}
                unoptimized
              />
              <span className="ml-2">Connect Microsoft</span>
            </Button>
          </div>
          <MutedText>
            Google and Microsoft connections use OAuth. No provider password is
            stored for OAuth mailboxes.
          </MutedText>
        </div>

        <div className="border-t pt-6">
          <ImapMailboxForm
            onConnected={onMailboxConnected}
            redirectPath={redirectPath}
          />
        </div>

        {helperText ? <MutedText>{helperText}</MutedText> : null}
      </CardContent>
    </Card>
  );
}
