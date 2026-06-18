---
sidebar_position: 2
title: Build, Test, and the Contribution Loop
description: 'How to build both layers, which test target needs what, and the exact PR compliance gate every contribution must pass.'
---

# Build, Test, and the Contribution Loop

## 1. Why this chapter exists

A pull request to this repository is closed automatically if it does not
reference an Issue, and it will not merge if SwiftLint or the offline-test build
fails. Before you write any code you need to know which build mode you are in
(downloaded binary FFI versus locally built FFI), which test target needs a
network or a local `lightwalletd`, and what the PR gate checks. This chapter
puts the compliance gate near the top so you can read it first, then maps each
CI job to the local command that reproduces it. By the end you will have run
`swift test --filter OfflineTests` and made a trivial change that you check with
SwiftLint. The files you touch are the FFI setup scripts under `Scripts/` and
any one Swift source file.

## The PR compliance gate (read this first)

These rules come straight from `CONTRIBUTING.md` and the repository conventions.
They are quoted, not paraphrased.

- Every PR must reference an Issue. From `CONTRIBUTING.md`: "Every Pull request
  must have an Issue associated to it. PRs with not associated with an Issue
  will be closed."

```ruby reference title="CONTRIBUTING.md"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/CONTRIBUTING.md#L52-L60
```

- Commit title format. From `CONTRIBUTING.md`, the "Preferred title format" is
  `[#{issue_number}] {self_descriptive_title}`, with the example
  `[#258] - User can take the backup test successfully more than once`.

```ruby reference title="CONTRIBUTING.md"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/CONTRIBUTING.md#L113-L121
```

- Squash-merge. From `CONTRIBUTING.md`: "We encourage our contributors to use
  Squash commits extensively. Maintainers prefer avoiding merge commits when
  possible. It is very much likely that if accepted, your contribution will be
  squash merged."
- CHANGELOG entry required. From `CONTRIBUTING.md`: "All enhancements and bug
  fixes need to be documented in the CHANGELOG."
- Developer's Certificate of Origin 1.1. By contributing you certify the four
  DCO clauses (a) through (d):

```ruby reference title="CONTRIBUTING.md"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/CONTRIBUTING.md#L167-L191
```

- SwiftLint forbids `print`, `debugPrint`, and `NSLog` in SDK code; use the
  injected `Logger` instead. It also forbids `+` string concatenation
  (`string_concatenation` is an error). These are enforced by the SwiftLint CI
  job below and described in `SWIFTLINT.md`.
- `TODO` format. Write `TODO: [#<issue_number>] ...`; a bare `TODO:` or
  `FIXME:` warns.

## 2. Definitions

The package builds in one of two FFI modes. `Package.swift` chooses between them
automatically based on whether `LocalPackages/Package.swift` exists.

```swift reference title="Package.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Package.swift#L5-L38
```

**Definition 2.1 (binary release mode).** The default. `LocalPackages/` does not
exist, so `Package.swift` adds a `.binaryTarget` named `libzcashlc` that SwiftPM
downloads from a GitHub Release by URL and verifies against a checksum
(`Package.swift` lines 30-37). No Rust toolchain is needed for Swift-only work.

**Definition 2.2 (local FFI mode).** `LocalPackages/Package.swift` exists
(created by `./Scripts/init-local-ffi.sh`), so `Package.swift` adds
`LocalPackages` as a path dependency and uses your locally built XCFramework
instead of the release binary (`Package.swift` lines 24-26). This is required
whenever you modify anything in `rust/`, and CI uses it too (it builds the FFI
from source and points `LocalPackages` at it).

**Rule 2.3 (do not ship a stale cached FFI).** `init-local-ffi.sh --cached`
downloads a pre-built release rather than building from source. Per
`docs/LOCAL_DEVELOPMENT.md`, only use `--cached` when your branch has no FFI
changes since the last release; a stale binary paired with modified Swift
bindings can silently corrupt wallet state.

### Test-target dependency table

The five test targets are declared in `Package.swift` (lines 76-98). What each
one needs at runtime:

| Test target          | External dependency                             |
| -------------------- | ----------------------------------------------- |
| `OfflineTests`       | nothing; this is what CI runs                   |
| `NetworkTests`       | a working internet connection                   |
| `DarksideTests`      | a local `lightwalletd` running in darkside mode |
| `AliasDarksideTests` | a local `lightwalletd` running in darkside mode |
| `PerformanceTests`   | network; not run in CI                          |

The darkside targets expect a local server started with
`Tests/lightwalletd/lightwalletd --no-tls-very-insecure --data-dir /tmp
--darkside-very-insecure --log-file /dev/stdout`, optionally with
`LIGHTWALLETD_ADDRESS` set.

## 3. The code

### Convenience targets (repo root `Makefile`)

The root `Makefile` wraps the four common operations. It does not build the FFI
itself; it delegates to the scripts.

```makefile reference title="Makefile"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Makefile#L20-L39
```

So `make init-ffi`, `make rebuild-ffi`, `make reset-ffi`, `make swift-build`,
and `make test-offline` are the entry points. `rebuild-ffi` takes
`REBUILD_TARGET` (default `ios-sim`).

### `init-local-ffi.sh`: switch into local FFI mode

The script branches on its flag. The `--macos-only` branch (fast path for
`swift build` / `swift test` on a Mac) builds a single macOS slice; the
`--cached` branch downloads and checksum-verifies a release; the default builds
the full XCFramework from source.

```bash reference title="Scripts/init-local-ffi.sh"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Scripts/init-local-ffi.sh#L21-L37
```

The default (build-from-source) branch runs the BuildSupport make target and
copies the result into `LocalPackages/`:

```bash reference title="Scripts/init-local-ffi.sh"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Scripts/init-local-ffi.sh#L78-L88
```

### `rebuild-local-ffi.sh`: fast single-arch incremental rebuild

After a Rust edit, rebuild one architecture. The command that does the work is a
single incremental `cargo build` for the selected target, followed by an atomic
swap of the XCFramework slice:

```bash reference title="Scripts/rebuild-local-ffi.sh"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Scripts/rebuild-local-ffi.sh#L95-L113
```

The target-to-triple mapping (which Rust target and which XCFramework slice each
of `ios-sim` / `ios-device` / `macos` selects) is the `case` block:

```bash reference title="Scripts/rebuild-local-ffi.sh"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Scripts/rebuild-local-ffi.sh#L41-L78
```

The full FFI build graph (lipo of per-arch static libraries into universal
slices, assembly into the XCFramework) lives in `BuildSupport/Makefile` and is
covered in [the FFI build pipeline](./05-ffi-build-pipeline.md).

### `reset-local-ffi.sh`: switch back to binary release mode

```bash reference title="Scripts/reset-local-ffi.sh"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Scripts/reset-local-ffi.sh#L5-L14
```

### CI jobs and the local command that reproduces each

There are two PR workflows. The offline-test workflow builds the FFI from
source (with caching), configures local FFI mode, builds the package, and runs
the offline suite:

```yaml reference title=".github/workflows/swift.yml"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/.github/workflows/swift.yml#L62-L100
```

The SwiftLint workflow runs on any `**/*.swift` change:

```yaml reference title=".github/workflows/swiftlint.yml"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/.github/workflows/swiftlint.yml#L1-L16
```

| CI job (workflow)                              | What it does                                                       | Local reproduction                                         |
| ---------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Build FFI for macOS (`swift.yml`, lines 63-72) | `cd BuildSupport && make macos`, assemble a macOS-only XCFramework | `./Scripts/init-local-ffi.sh --macos-only`                 |
| Configure local FFI (`swift.yml`, lines 84-90) | copy the XCFramework into `LocalPackages/`, add the SPM wrapper    | done for you by `init-local-ffi.sh`                        |
| Build Swift package (`swift.yml`, line 95)     | `swift build -v`                                                   | `make swift-build` (or `swift build`)                      |
| Run OfflineTests (`swift.yml`, lines 98-100)   | `swift test --filter OfflineTests`                                 | `make test-offline`                                        |
| SwiftLint (`swiftlint.yml`)                    | `norio-nomura/action-swiftlint` over the diff                      | `swiftlint` locally (install via `brew install swiftlint`) |

Per `docs/ci.md`, the FFI XCFramework release artifacts are produced by a
separate manual `workflow_dispatch` job (`build-ffi.yml`), not on every PR.

### Good first PR: where to start, by area

Recent merged PRs show the kinds of changes maintainers accept and which chapter
prepares you for that area. Titles confirmed from the merge commits in
`git log`:

- `#1761` enhance-failure-backoff (merge `fe836893`): submission/resubmission
  backoff. Prepared by [multi-server submission](./14-broadcaster-multi-server-submission.md).
- `#1760` fix-resubmit-race-on-first-sync (merge `44a6d9e2`): a race in
  `TxResubmissionAction` on first sync. Prepared by
  [the processor and actions](./07-compact-block-processor-and-actions.md) and
  [multi-server submission](./14-broadcaster-multi-server-submission.md).
- `#1759` treat-already-in-mempool-as-success (merge `e520d565`): treat an
  "already in mempool" response as a successful submission. Prepared by
  [transactions](./13-transactions-proposal-to-broadcast.md) and
  [multi-server submission](./14-broadcaster-multi-server-submission.md).
- `#1757` multiserver-submission (merge `04383463`): race submissions across
  multiple endpoints. Prepared by
  [multi-server submission](./14-broadcaster-multi-server-submission.md).
- `#1764` multiserver-changelog (merge `cb39408e`): the CHANGELOG entry for the
  multiserver work, in its own commit. Prepared by
  [the PR checklist](./91-pr-checklist.md).

To confirm a title yourself: `gh pr view 1761` (if `gh` is authenticated), or
`git log --oneline | grep -i "pull request"`.

## 4. Failure modes

- Opening `Package.swift` in Xcode without running `init-local-ffi.sh` on a
  development branch: SwiftPM tries to download a release binary that may not
  exist for your branch and fails with a 404. Caught by: the build step in
  `.github/workflows/swift.yml` (lines 84-95) configures local FFI before
  building, so CI catches the analogous failure; locally it surfaces at package
  resolution. No dedicated unit test.
- Editing `rust/` but forgetting `rebuild-local-ffi.sh`: Xcode keeps the previous
  XCFramework slice, so your Swift build links stale Rust code. Caught by audit
  only; the rebuild script's own output warns that the framework contains only
  the last-built target.
- Using `print`/`debugPrint`/`NSLog` or `+` string concatenation in SDK code:
  the SwiftLint job fails the PR. Caught by: `.github/workflows/swiftlint.yml`
  (and `swiftlint` locally).
- Omitting the Issue reference from the PR or the CHANGELOG entry: the PR is
  closed or blocked per `CONTRIBUTING.md`. No automated test in this workspace;
  caught by maintainer review.
- Running `init-local-ffi.sh --cached` on a branch that changed `rust/`: you link
  a release binary that does not match your Rust source. No automated test in
  this workspace; caught by audit only (Rule 2.3).

## 5. Spec pointers

- `CONTRIBUTING.md`
  (https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/CONTRIBUTING.md):
  the source of the Issue-reference rule, commit-title format, squash-merge
  preference, and the DCO 1.1 text quoted above.
- `SWIFTLINT.md`
  (https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/SWIFTLINT.md):
  the style guide, the approved-exception list, and the
  `// swiftlint:disable:next` form you must use if you ever disable a rule.
- `docs/LOCAL_DEVELOPMENT.md`
  (https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/docs/LOCAL_DEVELOPMENT.md):
  the full reference for the two FFI modes, the prerequisite Rust targets, the
  development loop, and the troubleshooting table.
- `docs/ci.md`
  (https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/docs/ci.md):
  describes the two PR checks and the manual release/FFI-build workflow.

## 6. Exercises

1. (Run the offline tests.) Set up local FFI on a Mac with
   `./Scripts/init-local-ffi.sh --macos-only`, then run
   `swift test --filter OfflineTests` (or `make test-offline`). Report the number
   of tests executed and whether they all pass.

2. (Trivial change plus SwiftLint.) Pick any SDK source file and add a comment
   line, or add a correctly formatted `TODO: [#0000] example` comment. Run
   `swiftlint` from the repo root and confirm it reports no new violations. Then,
   to see the gate bite, temporarily insert a line that concatenates two string
   literals with `+` and rerun `swiftlint`; observe the `string_concatenation`
   error, then revert.

3. (Map a job to a command.) For each of the five test targets in the dependency
   table, state whether the PR CI runs it, and if not, why. Cite the workflow
   step or the table.

4. (Read the mode switch.) Without running anything, explain from `Package.swift`
   exactly what file's existence flips the build from binary release mode to
   local FFI mode, and which lines add the path dependency.

### Answers in the code

1. The count is whatever your local run reports; CI runs the same command at
   `.github/workflows/swift.yml#L98-L100`.
2. The `string_concatenation` rule and the other forbidden constructs are
   described in `SWIFTLINT.md`; the CI job is `.github/workflows/swiftlint.yml#L1-L16`.
3. Only `OfflineTests` runs in PR CI (`.github/workflows/swift.yml#L98-L100`);
   `NetworkTests`/`PerformanceTests` need network and `DarksideTests`/
   `AliasDarksideTests` need a local `lightwalletd`, so they are not in the PR
   workflow.
4. The deciding file is `LocalPackages/Package.swift`; the detection is
   `Package.swift#L10` and the path dependency is added at `Package.swift#L24-L26`.

## 7. Further reading

- [The FFI build pipeline](./05-ffi-build-pipeline.md) for what
  `BuildSupport/Makefile` does under `init-local-ffi.sh`, including the lipo and
  XCFramework assembly steps.
- [The PR checklist](./91-pr-checklist.md) for a condensed, checkable version of
  the compliance gate at the top of this chapter.
