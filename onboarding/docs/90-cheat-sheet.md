---
sidebar_position: 90
title: Local Development Cheat Sheet
description: 'Every command a ZcashLightClientKit contributor needs, anchored to Makefile targets and the FFI scripts.'
---

# Local Development Cheat Sheet

This page is a flat command reference. Every row pairs a raw command with
the convenience `make` target that wraps it (when one exists) and a one-line
description. For the narrative explaining when and why you run these, see
[the build, test, and contribution loop](./02-build-test-contribution-loop.md).
The repo-root `Makefile` is intentionally thin: it forwards to the scripts
under `Scripts/` and to `swift`.

```makefile reference title="Makefile"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Makefile#L20-L39
```

## Setup

| Command                                                                                                               | What it does                                                                                                                                                                                  | Make target     |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `git clone https://github.com/zcash/zcash-swift-wallet-sdk`                                                           | Clone the repo.                                                                                                                                                                               | -               |
| `./Scripts/init-local-ffi.sh`                                                                                         | One-time FFI setup: builds the full XCFramework (all 5 architectures) and creates `LocalPackages/`, which `Package.swift` auto-detects to switch from the release binary to your local build. | `make init-ffi` |
| `./Scripts/init-local-ffi.sh --macos-only`                                                                            | Build only the macOS slice from your `rust/`. Fast; enough for `swift build` and `swift test` on a Mac. Single-slice, so iOS targets will not build until you rebuild for them.               | -               |
| `./Scripts/init-local-ffi.sh --cached`                                                                                | Download the pre-built release XCFramework instead of building. Only valid when your branch has no FFI changes relative to the release referenced in `Package.swift`.                         | -               |
| `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin x86_64-apple-darwin` | Install the Apple Rust targets required for a full FFI build.                                                                                                                                 | -               |

`make init-ffi` forwards directly to the script with no extra arguments:

```bash reference title="Makefile"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Makefile#L20-L22
```

The `--macos-only` and `--cached` flags have no `make` target; call the
script directly. The flag dispatch lives at the top of the script:

```bash reference title="Scripts/init-local-ffi.sh"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Scripts/init-local-ffi.sh#L21-L36
```

## Build

| Command          | What it does                                                                                                                              | Make target        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `swift build`    | Build the Swift package (macOS target). Requires `LocalPackages/` to exist (run `init-local-ffi.sh` first) or a published release binary. | `make swift-build` |
| `swift build -v` | Verbose build; what CI runs after configuring local FFI.                                                                                  | -                  |

## Test

| Command                                                     | What it does                                                                                                                           | Make target         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `swift test --filter OfflineTests`                          | Run the offline unit-test suite. This is the gate CI runs.                                                                             | `make test-offline` |
| `swift test --filter OfflineTests/<TestClass>/<testMethod>` | Run a single test method. Example: `swift test --filter OfflineTests/ZatoshiTests/testFormat`.                                         | -                   |
| `swift test --filter <TestClass>`                           | Run one test class across enabled suites.                                                                                              | -                   |
| `swift test`                                                | Run all enabled test targets. Most non-offline targets need external services (network, a local `lightwalletd`); see the loop chapter. | -                   |

`make test-offline` is exactly the filtered command:

```bash reference title="Makefile"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Makefile#L38-L39
```

## FFI rebuild (after editing Rust)

| Command                                     | What it does                                                                              | Make target                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| `./Scripts/rebuild-local-ffi.sh`            | Fast incremental rebuild for the iOS Simulator (default), auto-detecting arm64 vs x86_64. | `make rebuild-ffi`                           |
| `./Scripts/rebuild-local-ffi.sh ios-sim`    | Same as above, explicit.                                                                  | `make rebuild-ffi REBUILD_TARGET=ios-sim`    |
| `./Scripts/rebuild-local-ffi.sh ios-device` | Rebuild the iOS device slice (`aarch64-apple-ios`).                                       | `make rebuild-ffi REBUILD_TARGET=ios-device` |
| `./Scripts/rebuild-local-ffi.sh macos`      | Rebuild the macOS slice, auto-detecting arch.                                             | `make rebuild-ffi REBUILD_TARGET=macos`      |
| `./Scripts/reset-local-ffi.sh`              | Remove `LocalPackages/` and switch back to the release binary.                            | `make reset-ffi`                             |

`rebuild-local-ffi.sh` builds ONE architecture and atomically replaces the
XCFramework with a single slice, so a build for any other platform fails
until you rebuild for that platform. Run `init-local-ffi.sh` (all
architectures) before opening a PR that changes Rust. The single-arch cargo
build and atomic swap:

```bash reference title="Scripts/rebuild-local-ffi.sh"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Scripts/rebuild-local-ffi.sh#L95-L100
```

The `REBUILD_TARGET` variable defaults to `ios-sim`:

```makefile reference title="Makefile"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Makefile#L24-L27
```

## Lint and format

| Command                                    | What it does                                                                                                                    | Make target |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `brew install swiftlint`                   | Install SwiftLint (the project's Swift style gate). Do not install it as a CocoaPod.                                            | -           |
| `swiftlint`                                | Lint `Sources/ZcashLightClientKit/` and the sample app against `.swiftlint.yml`.                                                | -           |
| `swiftlint --fix`                          | Auto-correct the rules that support it.                                                                                         | -           |
| `swiftformat . --config zcash.swiftformat` | Apply the project's SwiftFormat rules (`redundantSelf`, `sortedImports`, `trailingCommas`, `trailingSpace`, `redundantParens`). | -           |

The SwiftFormat config is short and explicit:

```bash reference title="zcash.swiftformat"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/zcash.swiftformat#L1-L8
```

Three hard gates worth memorizing before you lint, all from
[`.swiftlint.yml`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/.swiftlint.yml#L83-L120):
`string_concatenation` (no `+` on strings, severity `error`),
`nslog_function_usage` (no `NSLog`, severity `error`), and `todos` (a bare
`TODO:` or `FIXME:` must carry a `[#<issue>]`). See
[the PR checklist](./91-pr-checklist.md) for the full list.

## Release

| Command                                   | What it does                                                                                                                                                                                            | Make target |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `./Scripts/release.sh <remote> <version>` | Fully automated release: pre-flight checks, builds and uploads a draft release, rewrites the `Package.swift` URL and checksum, commits, pauses for manual verification, then signs a tag and publishes. | -           |
| `./Scripts/prepare-release.sh <version>`  | Semi-automated alternative: builds the XCFramework and uploads the draft, leaving tagging and publishing to you. Preferred for security releases needing manual timing control.                         | -           |

`release.sh` requires a clean working tree, a GPG signing key, the `gh` CLI,
and the full Apple Rust toolchain. Its pre-flight checks reject a dirty tree
and a missing signing key before any build:

```bash reference title="Scripts/release.sh"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Scripts/release.sh#L64-L94
```

## Xcode notes

For FFI work, open the workspace, not `Package.swift`: `ZcashSDK.xcworkspace`
includes the `FFIBuilder` target, which runs `rebuild-local-ffi.sh` on each
build so Rust changes recompile automatically. Opening `Package.swift`
directly works but you must run `rebuild-local-ffi.sh` by hand after each
Rust edit (per `CLAUDE.md` and `docs/LOCAL_DEVELOPMENT.md`).

If Xcode shows stale headers, a 404 on package resolution, or does not pick
up FFI changes after switching modes: clean the build folder (Cmd+Shift+K),
then File > Packages > Reset Package Caches. If that fails, close Xcode and
delete `~/Library/Developer/Xcode/DerivedData`
(see [`docs/LOCAL_DEVELOPMENT.md`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/docs/LOCAL_DEVELOPMENT.md#L170-L199)).
