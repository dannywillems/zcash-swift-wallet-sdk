---
sidebar_position: 91
title: Pull Request Checklist
description: 'An actionable pre-push checklist mirroring CONTRIBUTING.md, the SwiftLint gates, and the repo conventions.'
---

# Pull Request Checklist

This page turns `CONTRIBUTING.md`, `SWIFTLINT.md`,
`CODE_REVIEW_GUIDELINES.md`, and the `CLAUDE.md` conventions into a single
pre-push checklist. Run through it before you open a PR; the same gates are
what a reviewer will check. For the narrative on the local loop these
commands fit into, see
[the build, test, and contribution loop](./02-build-test-contribution-loop.md).

## Hard gates

These are not stylistic preferences. A PR that misses one of these can be
closed or blocked.

- [ ] **The PR references an existing Issue.** Every PR must have an
      associated Issue; PRs without one are closed. If no Issue exists, file
      one first.
- [ ] **The commit title is `[#{issue_number}] {self_descriptive_title}`.**
      The first commit line is reused as the PR title and the release notes
      headline. Example: `[#258] - User can take the backup test
successfully more than once`. The PR number may optionally be appended
      in parentheses.
- [ ] **Your commits are DCO-signed off.** By contributing you certify the
      Developer's Certificate of Origin 1.1: that you wrote the code or have
      the right to submit it, and that the contribution and your sign-off are
      public and retained indefinitely. Add a sign-off line with
      `git commit -s`.
- [ ] **You expect a squash merge.** Maintainers avoid merge commits and
      will most likely squash-merge an accepted PR. Use squash commits during
      development; keep a pre-behavior refactor as its own commit when it
      eases review.
- [ ] **There is a `CHANGELOG.md` entry.** All enhancements and bug fixes
      must be documented in the changelog. Add the entry under the
      `# Unreleased` heading using the existing `## Added` / `## Fixed` /
      `## Changed` sections.
- [ ] **SwiftLint passes.** See the SwiftLint sub-checklist below.
- [ ] **Build and offline tests pass:**
      `swift build` then `swift test --filter OfflineTests`.
- [ ] **Breaking API changes are documented in `MIGRATING.md`** in addition
      to the changelog entry.

The Issue and squash-merge rules are stated directly in
`CONTRIBUTING.md`:

```markdown reference title="CONTRIBUTING.md"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/CONTRIBUTING.md#L54-L60
```

The commit title format is specified here:

```markdown reference title="CONTRIBUTING.md"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/CONTRIBUTING.md#L113-L119
```

The DCO 1.1 text you are certifying:

```markdown reference title="CONTRIBUTING.md"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/CONTRIBUTING.md#L167-L191
```

## SwiftLint sub-checklist

These are enforced by `.swiftlint.yml`. The first three are severity
`error`, so they fail the lint, not just warn.

- [ ] **No `print` or `debugPrint` in SDK/app code** (warning); use the
      injected `Logger` instead. SwiftLint's `print_function_usage` flags
      both functions.
- [ ] **No `NSLog`** (error); same rule, use the injected `Logger`.
- [ ] **No `+` string concatenation** (error); use string interpolation.
      The `string_concatenation` custom rule matches ` + "`, `" + `, and
      `+= "`.
- [ ] **Every `TODO:` / `FIXME:` carries an issue number**, formatted
      `TODO: [#<issue_number>] ...`. A bare `TODO:` warns via the `todos`
      rule.
- [ ] **SwiftLint disables are only the approved exceptions in `SWIFTLINT.md`**,
      always scoped with `// swiftlint:disable:next`, `:previous`, or a
      `disable`/`enable` region. Do not leave a rule disabled for a whole
      file.

The custom-rule definitions for the logging, concatenation, and TODO gates:

```yaml reference title=".swiftlint.yml"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/.swiftlint.yml#L91-L123
```

The rule on scoping disables, from `SWIFTLINT.md`:

```markdown reference title="SWIFTLINT.md"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/SWIFTLINT.md#L62-L69
```

## What reviewers also look for

From `CODE_REVIEW_GUIDELINES.md`, beyond the hard gates: a clear changelog
entry, new tests covering the requirements (and, for a bugfix, a test that
fails before the fix and passes after), edge-case and negative-case tests,
and code that follows existing conventions rather than introducing new
abstractions. The reviewer expects you to have self-reviewed and self-tested
non-minor PRs; reviewers are not expected to run your branch but may.

## Run before pushing

Copy-paste block. Adjust the FFI rebuild target if you changed Rust (see
[the cheat sheet](./90-cheat-sheet.md)).

```bash
# 1. If you edited Rust, rebuild the FFI slice you build against:
./Scripts/rebuild-local-ffi.sh macos   # or ios-sim / ios-device

# 2. Format and lint Swift:
swiftformat . --config zcash.swiftformat
swiftlint

# 3. Build and run the offline tests (the CI gate):
swift build
swift test --filter OfflineTests
```

Before a PR that changes the Rust/Swift FFI boundary, also run the full
all-architecture build so every slice compiles:

```bash
./Scripts/init-local-ffi.sh
swift test
```
