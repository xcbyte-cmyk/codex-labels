# Registered account selection — controlled restart

This source-only feature replaces the manual relogin guide and removes the old
app-server transport proxy from the installed runtime. It does not intercept
Desktop requests, patch initialization, monkey-patch spawn, or implement routing.

## User action and automated action

Open **계정 전환** in Labels. The native helper pre-registers the current file cache
and imports existing isolated Labels account profiles once. Select an account,
confirm that work/drafts are saved and that context may be sent to that account,
and confirm switching. The helper verifies the selected cached login, requests
normal Desktop quit, waits for the parent and children to exit, activates that
credential, verifies its full account/user identity and rate-limit endpoint using
the native CLI, then reopens the SAME runtime, CODEX_HOME and Electron profile.

This is actual credential activation and app restart, not a shortcut to a menu.
It does not send `account/logout`: revoking/removing a reusable cached session is
not necessary for a closed-app credential handoff. Native Codex owns token refresh.

Initial registration and explicit login renewal open the native browser flow in
a separate private temporary home. Completing browser authentication/MFA remains
a user action. Valid cached accounts switch without a browser. A verification
failure never silently selects a different account; the helper offers renewal.

## Supported boundary

Windows, managed ChatGPT login, **effective cli_auth_credentials_store=file**.
The native `config/read` response must confirm `file`. Keyring, auto, ephemeral,
API keys and external token-host authentication are rejected; settings and admin
policy are not silently changed. Missing/changed CLI response shapes are errors.
This precise native CLI contract is not yet verified against the user's binary.

Saved credentials are protected with Windows current-user DPAPI and current-user
ACLs, under LOCALAPPDATA/CodexLabels/AutoAccounts/<workspace hash>. No plaintext
fallback is used. Temporary CLI auth files are ACL-restricted before writing.
Deletion is ordinary deletion, not guaranteed secure erasure. Users/programs
running as the same OS account remain within the trust boundary.

A current cached identity shown on opening the picker is *not* online proof.
A successful handoff means an independent native CLI using the same home accepted
the target identity and rate-limit read, followed by a Desktop restart request.
It does not prove the restarted Desktop's displayed identity, a successful model
response, or billing/usage attribution. Those require real Windows verification.

All other detected Codex/ChatGPT consumers conservatively block activation.
Only the requesting Labels instance receives native app.quit; no other app is
closed. No forced Desktop termination is used. A native exit prompt remains user
controlled. A same-user external process starting in the tiny final check/write
interval cannot be universally excluded by this utility; do not run other Codex
clients concurrently with a handoff.

Saved history and project/label storage are not migrated or copied. A restart may
lose an unsaved draft, transient scroll or an ongoing response. Finish work first.
Separate account-window profiles are imported only as credential snapshots; their
conversations are not merged. Reusing stale snapshots in another client can
invalidate refresh tokens; renewed snapshots in this vault are never overwritten
by automatic imports.

## Failure and crash behavior

- Before verified normal exit: no active auth file modification.
- Activation/verification failure: restore the source credential, but do not
  launch a client under an uncertain target. Failure is shown in the helper.
- Third-party identity appeared: do not overwrite it; retain recovery state.
- Interrupted handoff: encrypted pending state blocks this updated runtime at
  startup and opens an explicit recovery helper, not a model client.
- Reopen failure after successful activation: keep verified target selected and
  report reopen failure. There is no automatic account fallback or model replay.

The source action only writes source files. No live accounts, installations,
shortcuts, pull requests or releases are modified by applying this delivery.
Build a fresh isolated candidate from the original supported Codex install;
old experimental runtime refresh is refused. Keep PR #24 Draft pending native
startup, A→B switching, history and usage checks.

References checked during implementation:
- OpenAI Authentication: https://developers.openai.com/codex/auth/
- OpenAI app-server: https://developers.openai.com/codex/app-server/
- Reference design (not vendored): https://github.com/liuzhao1225/codex-account-switcher
