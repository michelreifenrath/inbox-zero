"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useAction } from "next-safe-action/hooks";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { AlertError } from "@/components/Alert";
import { Input } from "@/components/Input";
import { toastError, toastSuccess } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { connectImapMailboxAction } from "@/utils/actions/imap-connection";
import {
  connectImapMailboxFormBody,
  type ConnectImapMailboxFormBody,
} from "@/utils/actions/imap-connection.validation";
import { getActionErrorMessage } from "@/utils/error";

const DEFAULT_PORTS = {
  imap: 993,
  smtp: 465,
};

export function ImapMailboxForm({
  onConnected,
  redirectPath,
}: {
  onConnected?: () => void | Promise<void>;
  redirectPath?: string;
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    watch,
    reset,
    formState: { errors },
    handleSubmit,
  } = useForm<ConnectImapMailboxFormBody>({
    defaultValues: {
      preset: "strato",
      email: "",
      password: "",
      username: "",
      imapHost: "",
      imapPort: DEFAULT_PORTS.imap,
      imapSecure: true,
      smtpHost: "",
      smtpPort: DEFAULT_PORTS.smtp,
      smtpSecure: true,
    },
    resolver: zodResolver(connectImapMailboxFormBody),
  });
  const preset = watch("preset");

  const { execute, isExecuting } = useAction(connectImapMailboxAction, {
    onSuccess: async () => {
      toastSuccess({ description: "Mailbox connected." });
      reset({
        preset: "strato",
        email: "",
        password: "",
        username: "",
        imapHost: "",
        imapPort: DEFAULT_PORTS.imap,
        imapSecure: true,
        smtpHost: "",
        smtpPort: DEFAULT_PORTS.smtp,
        smtpSecure: true,
      });
      await onConnected?.();
      if (redirectPath) {
        router.push(redirectPath);
      } else {
        router.refresh();
      }
    },
    onError: (error) => {
      const message = getActionErrorMessage(error.error);
      setServerError(message);
      toastError({ description: message });
    },
  });

  const onSubmit = (values: ConnectImapMailboxFormBody) => {
    setServerError(null);
    if (values.preset === "strato") {
      execute({
        preset: "strato",
        email: values.email,
        password: values.password,
      });
      return;
    }

    execute({
      preset: "custom",
      email: values.email,
      password: values.password,
      username: values.username,
      imapHost: values.imapHost,
      imapPort: values.imapPort,
      imapSecure: values.imapSecure,
      smtpHost: values.smtpHost,
      smtpPort: values.smtpPort,
      smtpSecure: values.smtpSecure,
    });
  };

  return (
    <form className="space-y-4" onSubmit={handleSubmit(onSubmit)}>
      {serverError ? (
        <AlertError
          title="Mailbox connection failed"
          description={serverError}
        />
      ) : null}

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">
          Mailbox type
        </legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            value="strato"
            className="mt-1"
            {...register("preset")}
          />
          <span>
            <span className="font-medium">STRATO preset</span>
            <span className="block text-muted-foreground">
              Uses STRATO's IMAP and SMTP servers automatically. Enter the
              mailbox password from STRATO, not your control panel login.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            value="custom"
            className="mt-1"
            {...register("preset")}
          />
          <span>
            <span className="font-medium">Custom IMAP/SMTP</span>
            <span className="block text-muted-foreground">
              Enter your incoming and outgoing mail server settings.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          type="email"
          name="email"
          label="Email address"
          registerProps={register("email")}
          error={errors.email}
          placeholder="you@example.com"
        />
        <Input
          type="password"
          name="password"
          label="Mailbox password"
          registerProps={register("password")}
          error={errors.password}
          placeholder="Mailbox password"
        />
      </div>

      {preset === "custom" ? (
        <div className="space-y-4 rounded-md border p-4">
          <Input
            type="text"
            name="username"
            label="Username"
            registerProps={register("username")}
            error={errors.username}
            placeholder="Usually your email address"
          />

          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <Input
              type="text"
              name="imapHost"
              label="IMAP host"
              registerProps={register("imapHost")}
              error={errors.imapHost}
              placeholder="imap.example.com"
            />
            <Input
              type="number"
              name="imapPort"
              label="IMAP port"
              registerProps={register("imapPort", { valueAsNumber: true })}
              error={errors.imapPort}
              min={1}
              max={65_535}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" {...register("imapSecure")} />
            Use SSL/TLS for IMAP
          </label>

          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <Input
              type="text"
              name="smtpHost"
              label="SMTP host"
              registerProps={register("smtpHost")}
              error={errors.smtpHost}
              placeholder="smtp.example.com"
            />
            <Input
              type="number"
              name="smtpPort"
              label="SMTP port"
              registerProps={register("smtpPort", { valueAsNumber: true })}
              error={errors.smtpPort}
              min={1}
              max={65_535}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" {...register("smtpSecure")} />
            Use SSL/TLS for SMTP
          </label>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        IMAP mailboxes are polled periodically and support reading plus SMTP
        send/reply/forward. Provider labels, filters, bulk archive, and
        provider-stored draft cleanup are not available.
      </p>

      <Button type="submit" loading={isExecuting} className="w-full">
        Connect mailbox
      </Button>
    </form>
  );
}
