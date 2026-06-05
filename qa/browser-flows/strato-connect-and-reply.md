---
id: strato-connect-and-reply
title: "STRATO mailbox connect, sync, and reply"
group: integrations
priority: low
resources:
  - inbox-zero-test-account
  - strato-mailbox
---

## Goal

Validate a real STRATO mailbox end to end in a browser without making normal CI depend on STRATO credentials or network state. This flow covers credentials login, the STRATO preset connection path, IMAP validation, SMTP validation, inbound sync, outbound reply/send, and cleanup of messages tagged with a unique run ID.

## Preconditions

- Inbox Zero test deployment URL is known and passed to `/qa-run` with `--base-url=<deployment-url>`.
- A dedicated Inbox Zero email/password test user is available.
- A dedicated STRATO test mailbox address and password are available from the secure QA environment.
- The STRATO mailbox can receive inbound mail from a second test mailbox and can send outbound mail through STRATO SMTP.
- The tester has access to the second test mailbox or another safe way to confirm reply delivery.
- Do not paste passwords or raw secrets into notes, screenshots, logs, or QA artifacts.
- Optional automated real-STRATO smoke runs must stay disabled unless explicit secrets are supplied, for example `STRATO_E2E_ENABLED=true`, `STRATO_E2E_EMAIL=<strato-test-mailbox>`, `STRATO_E2E_PASSWORD=<secret>`, and `STRATO_E2E_INBOX_ZERO_BASE_URL=<deployment-url>`.

## Steps

1. Generate a unique run ID such as `2026-06-05-qa-001`; use the exact subject tag `[inbox-zero-strato-e2e:<run-id>]` for every test message.
2. Open the Inbox Zero test deployment in a browser.
3. Sign in with the dedicated Inbox Zero email/password test user.
4. Open the account or mailbox connection flow from the app navigation.
5. Choose the STRATO preset.
6. Enter the STRATO mailbox address and password from the secure QA environment. Do not save the password in the browser, test notes, screenshots, or result artifacts.
7. Submit the connection form and confirm the IMAP validation step succeeds.
8. Confirm the SMTP validation step succeeds and the app reports the mailbox as connected.
9. From the second test mailbox, send an inbound email to the STRATO mailbox with subject `[inbox-zero-strato-e2e:<run-id>] inbound sync` and a body that contains only non-sensitive placeholder text.
10. In Inbox Zero, wait for polling/inbound sync, refresh if the product flow requires it, and confirm the inbound message appears in the STRATO mailbox inbox.
11. Open the synced inbound message in Inbox Zero.
12. Send a reply from Inbox Zero with subject/body that preserves the run ID tag and contains only non-sensitive placeholder text.
13. In the second test mailbox, confirm the outbound reply was delivered through STRATO SMTP and includes the run ID tag.
14. In Inbox Zero, open the sent or thread view for the STRATO mailbox and confirm the outbound reply/send is visible.
15. Search Inbox Zero, the STRATO mailbox, and the second test mailbox for `[inbox-zero-strato-e2e:<run-id>]` to identify every message created by this run.
16. Record only redacted evidence: deployment URL, run ID, pass/fail notes, and screenshots with mailbox passwords and raw secrets absent or obscured.

## Expected results

- Credentials login succeeds for the dedicated Inbox Zero test user.
- The STRATO preset is available in the mailbox connection flow.
- STRATO mailbox connection completes through the public UI path.
- IMAP validation succeeds for the STRATO mailbox.
- SMTP validation succeeds for the STRATO mailbox.
- The run-ID-tagged inbound message appears in Inbox Zero after inbound sync.
- A reply sent from Inbox Zero is delivered to the second test mailbox through STRATO SMTP.
- The outbound reply/send is visible in the STRATO mailbox thread or sent view.
- QA artifacts contain the run ID but no mailbox password, raw STRATO secrets, or unnecessary PII.

## Failure indicators

- Login fails for the dedicated Inbox Zero test user.
- The STRATO preset is missing from the connection flow.
- IMAP validation fails, times out, or reports the wrong mailbox.
- SMTP validation fails, times out, or sends from the wrong mailbox.
- The inbound sync message does not appear in Inbox Zero after the expected polling window.
- The outbound reply does not arrive in the second test mailbox.
- The run ID is missing from subjects, making cleanup or log search unreliable.
- Any screenshot, result file, browser console output, or copied error message contains a mailbox password or raw secret.

## Cleanup

- Search every involved mailbox for `[inbox-zero-strato-e2e:<run-id>]`.
- Delete all inbound, sent, reply, trash, and archive copies created by the run in the STRATO mailbox.
- Delete all matching messages created by the run in the second test mailbox.
- Remove the STRATO test mailbox connection from the Inbox Zero test account if the environment expects each run to start without a connected mailbox.
- Empty trash or deleted-items folders only for messages with the exact run ID tag when the mailbox provider makes that safe.
- Note any cleanup item that could not be completed in the QA result without including credentials or raw message content.
