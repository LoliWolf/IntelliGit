# Changelists and Selected Changes

Changelists are worktree-scoped metadata, not branches, stashes or separate Git
indexes. The Changes toolbar supports creating, renaming, removing and activating
lists, filtering their files and moving whole-file membership. The active list
owns newly discovered changes. Removing a list moves its membership to Default.

Open **Partial changes** for one checked ordinary text file. Select blocks or
individual added/deleted lines; the read-only, syntax-highlighted preview shows
the complete proposed file. Assign selected changes to a list, stage/unstage them,
use the selection in the Commit panel, or explicitly commit the selection.

The Commit panel routes partial inclusion through the selected-content workflow,
not its existing whole-file `commit --only` path. Committing a list includes only
its ownership in split files. Successful partial commits consume committed
ownership and leave an explicit empty inclusion for that scope; selecting the
whole file again is an explicit choice to include its remaining changes.

## Supported Scope

- Existing tracked UTF-8 regular files, at most 2 MiB, 100,000 lines and 16,384
  bytes per line; Git-compatible CRLF clean conversion.
- A selected commit includes 1 to 64 text files, at most 16 MiB of selected text.
- Detached HEAD and separate Git worktrees are supported.
- Binary/non-UTF-8 files, adds/deletes/renames/mode changes, submodules, sparse or
  assume-unchanged entries and custom filters/working-tree encodings use the
  existing whole-file/native workflow instead.
- Partial amend and partial stash/shelf/rollback are not implemented. A commit
  mixing partial text selections and unsupported structural changes must be
  split into separate explicit actions.
- No semantic/AST merge engine, LSP integration or full JetBrains equivalence is
  implied. Pure browser extension hosts without the Node Git backend are outside
  this workflow.

## Transaction Boundaries

The host computes Git diffs and owns immutable snapshots. Webviews send snapshot
and line IDs, never patches or arbitrary Git arguments. Snapshots fence the
canonical worktree, HEAD/ref, entire index, file bytes, operation state, attributes
and clean conversion. Dirty native buffers and symlink aliases are checked.

Partial stage/unstage builds an alternate index and atomically publishes it under
an exclusively acquired, inode-verified `index.lock`. It never writes the
worktree or advances HEAD.

Selected commits use an isolated Git directory with the original branch name,
the actual worktree, effective identity/signing settings, real hooks and a
selected index. Hook rejection and signer failure are failures, not bypasses.
The resulting tree and parent must match the selection before the commit object
is imported and the real ref is updated by compare-and-swap. Hooks can have their
own worktree/external side effects; those are not rolled back. Changes that hooks
add to the selected tree are refused, rather than silently committed.

The real index retains unrelated staging and is reconciled with the new HEAD.
Durable journals live under the worktree Git directory at
`intelligit/partial-index`. Recovery never deletes a foreign lock or overwrites
externally changed refs/indexes. An interrupted published commit reports that it
already succeeded and needs reconciliation, not another commit. POSIX directory
fsync is used; Windows has no equivalent directory fsync through this Node API.

Refused recovery records move to `intelligit/partial-index-quarantine`. Only a
lock with matching inode/device and prepared content is removed; changed/foreign
locks remain untouched. Recovery validates lock identity and bytes again before
publication. The Changes toolbar exposes a recovery-review action; confirmed
dismissal removes only the selected quarantined record, never Git history,
index, worktree or locks. Live foreign PIDs are reported conservatively and
are not unlocked or discarded; one such record does not block other recovery
entries or read-only snapshots.

Missing, invalid or oversized journal files are reported individually, not used
to block every recovery entry. Native review can explicitly discard their contained,
regular record directories even when the journal cannot be parsed. Pending records
that have become valid are not discarded through this unreadable-record path.
Unknown index locks are never removed with their metadata.

List writes use shared workspace storage, revision compare-and-swap and root-bound
commit leases. Stale assignments/selections require explicit review. Corrupt
metadata is refused, not overwritten.

Selected inclusion is persisted for its scope and the All view before Git
publication. A persistence failure aborts before committing; failed post-commit
metadata consumption leaves a durable old-snapshot fence and a success-with-review
warning, not a whole-file fallback. Index-side unstaging does not alter saved
working-tree inclusion.

If publication has not started and the captured repository/HEAD/ref remain
unchanged, a failed commit restores only the inclusion fields overwritten by that
attempt. Confirmed or uncertain ref publication keeps the new fence, even if
another process subsequently resets HEAD back to its old value. Failed metadata
restoration is reported for review instead of silently broadening the selection.

Working-tree staging also reserves the shared metadata lease and persists only
its current scope before publishing the index. A refused stage restores that
scope's prior inclusion under compare-and-swap, so dismissing a dirty native
buffer does not change what a later Commit panel action includes. A published
index requiring recovery retains its inclusion; failed rollback persistence
reports an explicit selection-review warning.

## Performance and Verification

Diffs are requested for the active file, not once per list. Text/snapshot caches
are bounded. Large commit trees virtualize above 200 visible rows using the
existing scroller and row components; small trees keep the existing layout.
The partial diff and CodeMirror preview also render bounded viewports.

The October 14 prototype measurement on an M2 Pro/32 GiB macOS host, Chromium
153.0.8010.12, production bundle and 20 lists measured a 10,000-file first render
of 69.8 ms, checkbox p95 of 33.4 ms, 40 rendered file rows and 6.81 MiB retained
JS heap growth. Before virtualization, the comparable file-list baseline measured
3,182.5 ms first render, 1,065.1 ms checkbox p95 and 335.85 MiB heap growth.
These small-sample, warm-cache harness results are not Electron IPC, remote
filesystem latency or a bound on hook/signing time. Initial full-stat host refresh
still costs roughly one second at 10,000 changed files; lazy statistics are not
implemented here.

Focused verification:

```sh
bun x vitest run tests/unit/changes tests/integration/changes
bun x playwright test --config playwright.visual.config.ts tests/visual/partialChanges.spec.ts
bun x playwright test --config playwright.e2e.config.ts --project=e2e tests/e2e/partialChanges.spec.ts
```

Pixel baselines must come from the repository's pinned Linux renderer. macOS
screenshots are diagnostic evidence, not replacement Linux baselines.
