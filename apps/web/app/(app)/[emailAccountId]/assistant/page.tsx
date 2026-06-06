import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import prisma from "@/utils/prisma";
import { PermissionsCheck } from "@/app/(app)/[emailAccountId]/PermissionsCheck";
import { EmailProvider } from "@/providers/EmailProvider";
import { ASSISTANT_ONBOARDING_COOKIE } from "@/utils/cookies";
import { prefixPath } from "@/utils/path";
import { Chat } from "@/components/assistant-chat/chat";
import { checkUserOwnsEmailAccount } from "@/utils/email-account";

export const maxDuration = 300; // Applies to the actions

export default async function AssistantPage({
  params,
  searchParams,
}: {
  params: Promise<{ emailAccountId: string }>;
  searchParams: Promise<{ onboarding?: string | string[] }>;
}) {
  const [{ emailAccountId }, resolvedSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  const onboarding = getSingleSearchParamValue(resolvedSearchParams.onboarding);
  await checkUserOwnsEmailAccount({ emailAccountId });

  // onboarding redirect
  const cookieStore = await cookies();
  const viewedOnboarding =
    cookieStore.get(ASSISTANT_ONBOARDING_COOKIE)?.value === "true";

  if (!viewedOnboarding) {
    const hasRule = await prisma.rule.findFirst({
      where: { emailAccountId },
      select: { id: true },
    });

    if (!hasRule && onboarding !== "true") {
      redirect(prefixPath(emailAccountId, "/assistant?onboarding=true"));
    }
  }

  return (
    <EmailProvider>
      <Suspense>
        <PermissionsCheck />

        <div className="flex h-[calc(100vh-theme(spacing.9)-theme(spacing.14)-env(safe-area-inset-bottom))] md:h-screen flex-col">
          <Chat open />
        </div>
      </Suspense>
    </EmailProvider>
  );
}

function getSingleSearchParamValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
