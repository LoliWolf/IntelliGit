# Repository Ownership in Remote Workspaces

IntelliGit runs in the workspace extension host. With Remote SSH, that host and
its Git subprocesses belong on the remote machine, not beside a same-path local
clone. VS Code translates remote resources into agent-side `file:` URIs; accepting
arbitrary remote URIs as local paths is not the fix.

The manifest explicitly selects the workspace host and declines virtual-only
workspaces, because Git and the transaction/recovery implementations require a
native filesystem. Activation refuses untranslated remote workspace folders or
a forced UI-host override before registering Git handlers. It does not rewrite
the user's `remote.extensionKind` settings.

## Independent Panels

An undocked panel can select repository B while the docked views still show A.
Previously, its branch menu forwarded only the branch object to global commands,
which used A's executor. An already-up-to-date pull or already-contained merge in
A could succeed while B remained unchanged.

Branch, bulk-delete, commit-action and worktree messages identify the repository
that rendered their rows. Addressed mutation callbacks retain their rendered
root; the host rejects stale, missing or unavailable roots instead of substituting
the current selection. Dispatch captures repository-bound Git services, reloads
the branch/worktree inventory, retains the operation fence and routes completion
refreshes and conflicts back to that repository. Names absent from the captured
repository are refused. Branch lookup is indexed rather than quadratic for bulk
selection.

Merge and Update can use undecorated branch metadata if the auxiliary worktree
listing fails. Checkout, Delete and other commands remain blocked on that failure;
an unavailable worktree inventory is not substituted with an empty safe list.

Undocked Fetch, Push and Sync also derive their Git facade before waiting for
progress or consent. Pull retains its existing captured-root update transaction.
Publish, including first Push on an unpublished branch, carries the same root
through the native command and credential flow. Native branch commands also
capture their services before an operation fence or prompt. Worktree services
are owned by one command and disposed after its captured-root refresh.
Tracked file rows carry repository metadata in native context menus, so
Rollback, Delete and Stash do not silently use the global repository. Stash
conflicts open the conflict session for the repository actually changed.
No Git error is converted into success, and no history, index, worktree or
partial-commit safety limit is relaxed.

## Execution and Mutation Destinations

Execution on the SSH machine does not mean every action changes its checked-out
files. Ordinary Git runs through the workspace-host `GitExecutor`; authenticated
clone/publish uses that host's askpass process. The interactive terminal rebase
fallback is user-controlled and does not observe completion.

| Operation | Intended mutation | Expanded physical SSH assertion |
| --- | --- | --- |
| Log, Diff, Status | Read repository state; no working-tree or branch-content update | Host dispatch audit, not a claim of writes |
| Fetch | Update SSH checkout's remote-tracking refs | Tracking ref advances, checkout HEAD stays unchanged |
| Pull, Update, Merge | Integrate into the addressed SSH checkout | B's expected HEAD/content changes; A stays unchanged |
| Commit | Update SSH checkout's commit/ref and index | Both undocked B and sidebar B create the intended commit while global A stays active |
| Push | Send commits to the configured Git remote | Read B's bare origin ref and committed blob, not only B's tracking ref or a success toast |
| Sync | Integrate incoming commits and push local commits | Both incoming and rebased local content reach B's origin |
| New Branch, Publish, Checkout | Change B's branch and create its remote ref | New unpublished B branch appears only in B's origin, then B checks out main |
| Stash, Pop, Rollback | Change B's stash/index/working tree | B's bytes and stash state change; A and A's origin remain unchanged |
| Native file-row Rollback | Restore the repository named by the row | Sidebar B restores its file while global A stays active |
| Worktree Lock, Unlock, Delete | Change the addressed repository's worktree metadata/directory | B's detached owned worktree changes; A stays unchanged |
| Rejected Push | Report failure without losing the local commit or changing the server ref | Real owned pre-receive hook refuses; error is visible and no new push-success message appears |

The expanded opt-in case uses separate disposable bare origins for A and B.
After fixture preparation it compares unrelated A's HEAD, branch refs, logical
index, status, working-file bytes and origin refs throughout the operations.
This is one scenario with multiple assertions, not an exhaustive certification
of every command/configuration combination.

File-row Delete/Stash, worktree Move/Prune/Repair and selection changes during
prompts have focused unit coverage. Partial transactions, advanced history
rewrites, conflict recovery, hosted Git authentication, signing, alternate
platforms and manual terminal sessions still require their own specific
validation. A legitimate already-up-to-date operation can succeed without a
content change, and server permissions or hooks can refuse a push.

## Verification

The normal native suite includes `branchRepositoryScope.spec.ts`. Its two real
Git/VS Code cases make A a valid no-op target and B a target with actual incoming
content, then verify Update and Merge advance B while A stays unchanged.
It explicitly selects docked A through native UI, verifies the existing
repository-selection memento, and closes the host sidebars at 1280 content pixels
so responsive pane hiding does not prevent the test from reaching the selector.

Cold multi-repository startup also exercises concurrent shelf-parent creation.
An `EEXIST` after a missing-directory observation is rechecked with `lstat`,
followed by the existing directory, symlink and containment checks. Files and
symlinks raced into the path remain refused.

Unit and integration cases cover explicit-root routing, selection changes during
the operation fence, invalid roots, stale renderer callbacks, workspace-host
affinity and unchanged local activation.

`remoteSshWorkspace.spec.ts` is a separate opt-in test against an explicitly
configured SSH host. It creates disposable remote repositories, deploys the
selected extension payload and VS Code Server below its own temporary directory, and
removes only those owned fixtures and server processes. It does not use a real
project checkout or the user's existing remote VS Code Server installation.
It requires a compatible local Remote-SSH extension and a remote Node executable:

```sh
INTELLIGIT_REMOTE_SSH_HOST=configured-ssh-alias \
INTELLIGIT_REMOTE_NODE=/absolute/path/to/node \
INTELLIGIT_REMOTE_SSH_EXTENSION_PATH=/path/to/compatible/remote-ssh-extension \
bun x playwright test --config playwright.e2e.config.ts --project=e2e --no-deps \
  tests/e2e/remoteSshWorkspace.spec.ts
```

Optional inputs:

- `INTELLIGIT_REMOTE_WORKSPACE_PARENT`: an absolute existing remote project
  directory. A fresh `intelligit-ssh-workspace-*` child is allocated; cleanup
  refuses the parent, unrelated names, outside paths and symlinks.
- `INTELLIGIT_REMOTE_SERVER_ARCHIVE`: a previously downloaded official server ZIP
  for the exact client version and commit. Archive traversal and symlink entries
  are rejected, transport SHA256 and remote product identity are checked, and the
  seed uses the product data folder below Remote-SSH's configured install base.
- `INTELLIGIT_REMOTE_VSIX`: a production package to install with the isolated
  remote server CLI. Requires the server archive above; the exact installed
  extension version and package transport hash are checked. The client has no
  `extensionDevelopmentPath` in this mode.

The UI test explicitly pins docked A and independently selects undocked B,
checking the native repository picker before and after that selection. Branch
Update, undocked Pull and Merge must change remote B while A remains unchanged.
It then selects B in the sidebar and verifies another real Pull retains the
previously merged content. The remote workspace must not exist on the local
client filesystem. Seeded runs also verify the live server uses the isolated
data directory. Git operations are driven through the actual UI; SSH is used
only for fixture preparation, state assertions and cleanup.

On October 15, 2026, the full physical Remote-SSH UI workflow passed with both a
development payload and an installed production 0.37.3 VSIX, using actual client
and server 1.132.0 and a compatible Remote-SSH 0.124.0. The installed run had no
development-path flag and checked all four operation paths. Owned project and
server-process counts returned to zero; existing projects and the original
server installation were unchanged.

On October 16, 2026, the expanded installed-production scenario passed on the
same client/server versions with retries disabled. It additionally checked
tracking-only Fetch, undocked and sidebar Commit/Push into a separate bare
origin, bidirectional Sync, native file-row Rollback, Stash/Pop/Rollback,
New Branch/Publish/Checkout and worktree Lock/Unlock/Delete. A real pre-receive
hook rejected the final Push: the error appeared, the origin ref stayed
unchanged, the local commit survived and no new push-success notification
appeared. Unrelated A and its origin remained unchanged after fixture
preparation. Owned remote projects, server processes and local client profiles
returned to zero.

Earlier automatic-download attempts remained unverified and are not relabeled
passing. The later successful runs used an exact-build server seed. The fixtures
use a disposable file-origin Git remote on the SSH machine; this does not claim
hosted Git authentication, signing or remote performance validation. This private
host opt-in test remains separate from the required source CI suite.
