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

Branch and bulk-delete messages now identify the repository that rendered their
rows. The host rejects stale, missing or unavailable roots instead of substituting
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
No Git error is converted into success, and no history, index, worktree or
partial-commit safety limit is relaxed.

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

Earlier automatic-download attempts remained unverified and are not relabeled
passing. The later successful runs used an exact-build server seed. The fixtures
use a disposable file-origin Git remote on the SSH machine; this does not claim
hosted Git authentication, signing or remote performance validation. This private
host opt-in test remains separate from the required source CI suite.
