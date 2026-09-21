# Issue #21 — Session-preserving account switch core

Status: **transaction core plus a window-level Account Switcher UI; native in-place app-server switching is not wired yet.**

## Installed window switcher

The Labels badge menu and settings expose **Account Switcher**. It lists the default profile and registered isolated account windows. Selecting another account starts that verified account window through `CodexLabelsHelper.exe`, waits for the helper to confirm launch, then hides the source window. The source session remains alive and can be restored from the tray.

This window-level switcher does not copy a conversation or change the backend account of the current window. It provides a usable account transition while preserving strict profile isolation. The UI states this boundary before the user switches.

This change introduces the transaction layer needed for a session-preserving account switch without claiming that the current Codex Desktop backend can already be hot-swapped.

## Included

- `SessionAccountRouter` with a single commit point for account changes.
- Source/target account + user + workspace identity verification.
- Explicit consent before cross-account local context transfer.
- Fail-closed switching while turns, tool calls, approvals, or commands are active.
- Passive checkpoint/restore contract for logical-session continuity.
- Cancellation and cleanup fencing for late-created target backends.
- Pre-commit rollback by retaining the source backend.
- Post-commit cleanup failure reporting: target stays active but the router blocks new work until recovery.
- No automatic turn replay on another account.
- Usage normalization for Codex rate-limit windows without inventing missing quota data.

## Backend contract

A production backend adapter must expose:

```text
capabilities = {
  protocolVersion: 1,
  isolatedCredentials: true,
  identityPinned: true,
  passiveRestore: true,
  fullActivity: true
}

getIdentity()
getActivity()
checkpoint({signal})
restore(checkpoint, {signal})
runTurn(input, {signal, onEvent})
readUsage({signal})
close()
```

The adapter must own an isolated account backend. It must not reuse a backend that is still shared by another window/session.

## Important limitation

This PR does **not** yet:

- register/manage real login credentials,
- patch the installed Desktop app-server transport,
- prove that a native remote thread can be reused across accounts,
- add these modules to `prepare_runtime.py`,
- modify or install the user's current Codex/Labels runtime.

The intended production design is to preserve the **logical/local working session** while rebuilding an account-scoped backend when the native server-side thread cannot cross account boundaries.

## Safety/consistency rules

- Never switch merely because an `auth.json` file changed.
- Never report success before target identity and passive restore are verified.
- Never transfer context when the current backend has pending work.
- Never silently retry a billable/model/tool request on another account.
- Never expose raw credentials or backend authentication errors to renderer-visible state.
- If cleanup cannot be confirmed, block new requests until explicit recovery.

## Tests

PR regression tests cover:

- successful logical-session-preserving switch,
- explicit transfer consent,
- identity mismatch before transfer,
- active work blocking,
- restore rollback,
- cancellation of late target creation,
- no automatic replay after a turn error,
- usage clearing on account commit,
- post-commit cleanup failure + recovery,
- rate-limit normalization and secret filtering.

The broader prototype suite was also run locally before publishing this Draft PR:

```text
node --test extension/account-usage.test.cjs extension/session-account-router.test.cjs
61 passed, 0 failed
```

Those 61 cases use backend doubles; they are not proof of a working real-account Desktop switch.

## Next integration step

1. Identify the supported app-server/backend lifecycle boundary in the bundled Windows Codex runtime.
2. Implement a real isolated backend adapter with trusted identity verification.
3. Gate all session dispatch through the router.
4. Replace the window-level switch with trusted in-place IPC only after the adapter proves the required identity and restore contracts.
5. Verify with two real accounts that the next request is billed to the selected account while the visible working session remains intact.
6. Only then add the new modules to runtime packaging and close issue #21.
