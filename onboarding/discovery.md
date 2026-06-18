# Discovery notes

Ground truth for chapter selection. Produced during the onboarding-course
generation. The course is pinned to the upstream repository at the commit
recorded below; do not change the pin without re-checking every source embed.

## Pin

- Upstream repository: `https://github.com/zcash/zcash-swift-wallet-sdk`
- Pin commit (the `main` tip at generation time):
  `fe836893bc71fc3e6eb173f4fc191aa43c3760af`
- Confirmed to resolve on GitHub via `gh api`.
- The local working tree had one extra commit on top ("Delete trailing
  whitespaces", `01eb750b`) which is a whitespace-only diff and does not shift
  line numbers relative to the pin.

## Publication target

- Fork: `dannywillems/zcash-swift-wallet-sdk`, branch `onboarding`.
- Pages URL: `https://dannywillems.github.io/zcash-swift-wallet-sdk/`.
- Deploy: GitHub-Actions-sourced Pages (artifact upload, no rendered HTML
  committed to the branch).

## Repository facts

- Swift Package (`swift-tools-version:5.6`), products: `ZcashLightClientKit`
  library. Platforms iOS 13+, macOS 12+. `Package.swift`.
- The Rust core `libzcashlc` (`Cargo.toml`, crate-type `staticlib`) is compiled
  into an `xcframework`. SPM pulls a pre-built binary from GitHub Releases by
  default (binary target URL + checksum in `Package.swift`), or builds locally
  when `LocalPackages/Package.swift` exists.
- Rust edition 2024, rust-version 1.90. Release profile uses `lto = true`.
- Rust dependencies of note (`Cargo.toml`): `orchard` 0.14
  (`unstable-voting-circuits`), `sapling-crypto` 0.7, `zcash_client_backend`
  0.23, `zcash_client_sqlite` 0.21, `zcash_primitives` 0.28, `pczt` 0.7,
  `zcash_voting` 0.11, `tonic` 0.14, `tor-rtcompat` 0.35. FFI tooling:
  `cbindgen` 0.29, `bindgen` 0.72, `cc` 1.0.

## Build / test

- `swift build` (macOS), `swift test --filter OfflineTests` (CI default).
- Test targets gated by dependencies: `OfflineTests` (none), `NetworkTests`
  (internet), `DarksideTests` / `AliasDarksideTests` (local `lightwalletd`),
  `PerformanceTests` (network, not in CI). Shared test plan
  `ZcashLightClientKit.xctestplan` enables only `OfflineTests`.
- Root `Makefile` targets: `init-ffi`, `rebuild-ffi`, `reset-ffi`,
  `swift-build`, `test-offline`. FFI build graph in `BuildSupport/Makefile`.
- FFI scripts: `Scripts/init-local-ffi.sh` (full, or `--macos-only`),
  `Scripts/rebuild-local-ffi.sh [ios-sim|ios-device|macos]`,
  `Scripts/reset-local-ffi.sh`, `Scripts/release.sh`,
  `Scripts/prepare-release.sh`.

## CI graph (`.github/workflows/`)

- `swift.yml`: builds and runs `OfflineTests`.
- `swiftlint.yml`: SwiftLint.
- `build-ffi.yml`: `workflow_dispatch` to build the XCFramework release
  artifacts.
- `codeql.yml`: CodeQL static analysis.
- `zizmor.yml`: GitHub Actions workflow security linting.

## PR compliance gate (surface verbatim in Chapter 02)

From `CONTRIBUTING.md`:

- Every pull request MUST reference an existing Issue. "PRs not associated with
  an Issue will be closed."
- Commit title format: `[#{issue_number}] {self_descriptive_title}`.
- Developer's Certificate of Origin 1.1 applies to every contribution.
- PRs are typically squash-merged; maintainers avoid merge commits.
- All enhancements and bug fixes must be documented in `CHANGELOG.md`.

From `CLAUDE.md`: never `print`/`debugPrint`/`NSLog` (SwiftLint enforces;
use the injected `Logger`); use string interpolation not `+`; format TODOs as
`TODO: [#<issue>] ...`; SwiftLint disables only as listed in `SWIFTLINT.md`.

## Hot files (most-changed, last 6 months)

`rust/src/lib.rs`, `rust/src/ffi.rs`,
`Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift`,
`Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift`,
`rust/src/voting/*`, `rust/src/tor.rs`, `rust/src/derivation.rs`,
`rust/build.rs`, `Sources/ZcashLightClientKit/Broadcaster.swift`,
`Tests/TestUtils/SubmissionTestDoubles.swift`,
`Sources/ZcashLightClientKit/Error/ZcashErrorCodeDefinition.swift`. The recent
work clusters on multi-server transaction submission (MOB-1039), enhancement
failure backoff, and voting.

## Canonical references

- Zcash Protocol Specification: https://zips.z.cash/protocol/protocol.pdf
- ZIPs: https://zips.z.cash/
- `librustzcash`: https://github.com/zcash/librustzcash
- `lightwalletd`: https://github.com/zcash/lightwalletd
- Repo docs: `docs/Architecture.md`, `docs/LOCAL_DEVELOPMENT.md`,
  `docs/cbp_state_machine.puml`, `MIGRATING.md`.

## Chapter graph (no study plan, per request)

1. Module map (two-layer architecture)
2. Build, test, and contribution loop
3. The Rust core: libzcashlc and the FFI surface
4. The Swift bridge: ZcashRustBackend and the welding protocols
5. The FFI build pipeline: build.rs, cbindgen/bindgen, XCFramework, LocalPackages
6. The synchronizer and the public API
7. CompactBlockProcessor and the Action state machine
8. Block download and filesystem storage
9. Scan, enhance, and fetch UTXOs (spend before sync)
10. Persistence: data.db, DAO, Repository
11. Networking: LightWalletService and gRPC
12. Tor transport
13. Transactions: proposal to PCZT to broadcast
14. The broadcaster and multi-server submission
15. The voting subsystem
16. Checkpoints and wallet birthday
17. The error model (generated ZcashError)

- Reference pages: local development cheat-sheet, PR checklist, glossary.
