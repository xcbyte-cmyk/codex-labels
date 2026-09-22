# Workspace account authority and replaceable connections

This change addresses PR #24, comment `5769049510`, against commit
`a8958fea116a1225f0c6dfc346cd212157d1eab6`.

## Cause and scope

The previous installer assumed one live `WorkspaceGateway`. A second matching
app-server spawn raised `UNSUPPORTED`, terminated that child, and poisoned the
shared start error. The reported Desktop run starts overlapping/replacement
connections, so this assumption was invalid. Authentication response shape was
not the reported failure.

`install()` now creates one `WorkspaceCoordinator` for the canonical CODEX_HOME
and attaches a `WorkspaceConnection` to every compatible stdio child. Each child
keeps its own initialize/initialized handshake, IDs, request stream, approvals,
notifications, loaded threads, and native PID/exit handling. A second healthy
child is not terminated. The old standalone gateway remains for compatibility
and primitive protocol validation; production installation uses the coordinator.

The authority is shared inside one Labels Electron main process. Separate
application processes, unrelated installations, remote transports, and tools
launched outside this hook are not coordinated by this patch. A different
CODEX_HOME in the same hook is rejected rather than silently mixed with the
current workspace. Schema/help commands are not app-server transports and are
not intercepted. Unsupported work-capable transports are rejected before spawn.

## Account transaction

The coordinator is the only workspace selection writer. It owns the active
principal, selected profile, durable pending state, membership generation,
operation lock, recovery state, and cancellation flag. It does not store tokens
or conversation bodies in its state file.

Before switching, all initialized connections must be verified, with no turns,
tools, approvals, streaming commands, unknown background terminal pages, or
external requests in flight. Every member's live principal and paginated normal
and archived catalog are checked. All members then authenticate the target and
verify their own catalog and live identity again. The selected state is published
only after these checks, with one commit point. No history, labels, projects, or
CODEX_HOME paths are moved or merged. No model request is issued by switching.

If membership changes during the operation, the transaction fails closed and
rolls back every live touched member. Newly attached connections wait for the
outcome, then join the committed or restored principal. The user retries the
switch after membership stabilizes; there is no automatic model-request replay.
Failure to confirm rollback leaves a durable recovery barrier.

A replacement starts its own protocol handshake before auth probes. Remembered
selected credentials are reapplied before work-capable messages can pass. Missing
or mismatched credentials do not cause native/default-account fallback. Initial
native identity is pinned across reconnections and recorded application restarts.
Native logout/login gates all peers until explicit consent-based recovery aligns
them. Both external-token refreshes and native-host refresh replies must preserve
the pinned account/user identity.

Local history reads remain available while authentication is blocked. A joining
connection blocks *new* work, but does not automatically decline legitimate tool
approvals in an already-running, still-verified peer.

## Closure and diagnostics

An idle transport's confirmed exit removes only that member. The authority and
selected account survive even when no transports remain. EOF/timeout without OS
exit is retired and held behind the barrier until shutdown is confirmed. A lost
connection with ambiguous active work persists a recovery requirement; a new
connection does not imply that the old work safely finished. Late callbacks from
removed members cannot change the current authority.

Status includes live, verified and retiring connection counts, plus the account
generation. No tokens, request payloads, email addresses, or conversation contents
are added to these diagnostics. The renderer shows synchronization and retirement
rather than presenting transient connection replacement as global UNSUPPORTED.

## Verification and remaining release gate

Automated checks use deterministic protocol doubles and a real Node child-process
fixture. These tests exercise the production spawn wrapper, but **are not real
Codex authentication or Windows Desktop tests**. Before merge/distribution:

1. Build an isolated Windows candidate from this source; retain stable runtime
   and shortcuts unchanged.
2. Repeat the reported startup with the existing local catalog and zero registered
   targets. Confirm multiple connections can become verified without termination
   and there is no renderer recovery loop.
3. Register two authorized test accounts using the existing account manager.
   Verify A to B, B to A, overlapping connections, reconnect after idle closure,
   new turns, interruption, approvals, failure/rollback, and restart.
4. Verify authenticated request ownership and quota behavior with real accounts;
   mock `turn.account` fields do not prove billing or quota attribution.
5. Verify normal/archived catalogs, filters, titles, drafts, scroll position,
   labels, auth files and runtime cleanup. Run complete repository CI.

Keep PR #24 Draft until these real-device checks pass. The report's 496 rollout
files and unchanged hashes are prior-device evidence, not measurements reproduced
by this patch's automated tests.

Protocol reference: https://developers.openai.com/codex/app-server/
Original report: https://github.com/xcbyte-cmyk/codex-labels/pull/24#issuecomment-5769049510
