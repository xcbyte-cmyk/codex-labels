# One-click registered account switching

The former account selector launcher and the in-app account button now open
this same screen (issue #25). The launcher forwards an open-picker request to
the owning Desktop so its original quit channel and workspace remain intact.
The list marks the current cached account and imports credentials from existing
account-window profiles without moving or deleting their conversation files.
Account registration, renewal and removal are available in this single screen.

Open **계정 전환**, select a saved account, and press **선택 계정으로 전환 및 재실행**.
The button itself is explicit consent to use existing conversation/code context
with the selected account. There are no consent checkboxes, force-mode options,
or additional switch confirmation dialogs.

The helper requests shutdown of the Labels instance that opened it, writes the
selected saved credential, and reopens the same runtime, CODEX_HOME and Electron
profile. It does not enumerate other Codex sessions, block on other applications,
or call online account/config/rate-limit probes during switching. Other apps are
not closed. Only the requesting instance and its children are awaited as part
of its restart; native app exit prompts can still appear.

Saved accounts are applied directly. Initial registration and explicit renewal
use the native browser login flow in a private temporary home. Token refresh and
expired-login handling during normal use belong to the restarted native client.
This feature writes managed ChatGPT file credentials; it does not migrate a
keyring configuration or override administrator policy.

Credentials remain protected with Windows current-user DPAPI and private file
permissions. File-format checks, atomic writes and encrypted crash recovery
remain, as they implement storage rather than a session preflight. A failed
write preserves the original credential. An interrupted transaction opens the
recovery helper. Reopen failure leaves the selected cache in place and reports
the error. Recovery restores the prior cache without online or session checks.

No history or project files are moved or filtered. An application restart can
lose transient drafts/scroll state. Separate account-window profiles contribute
credential snapshots only; their conversation histories are not merged.

A successful result reports cache-reopened: the selected saved credential was
written and the app restarted. It does not claim online authentication, model
request success, or usage attribution. Real A-B-A usage attribution remains an
open validation item for Draft PR #24.

Tests use synthetic credentials and an isolated LOCALAPPDATA. They cover a
single button press without checkboxes/confirmation, absence of online/session
gates, same-workspace history preservation, failed writes and recovery.
