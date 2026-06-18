---
sidebar_position: 15
title: The Voting Subsystem
description: 'The voting FFI surface: delegation, encrypted shares, recovery, rounds, PIR snapshot resolution, and the tree-sync client, with the cryptography deferred to the upstream crates.'
---

# The Voting Subsystem

## 1. Why this chapter exists

The voting subsystem is an actively developed area that wraps an off-semver
upstream voting protocol. Its Swift surface (`VotingRustBackend`) talks to the
Rust `libzcashlc` voting FFI almost entirely through JSON-in / JSON-out calls,
a different style from the rest of the SDK bridge. A contributor who changes a
field name on one side of a JSON payload, or who probes a Private Information
Retrieval (PIR) server serving the wrong chain snapshot, produces proofs the
chain rejects, and the failure surfaces far from the cause. This chapter maps
the named voting concepts to their files, walks one representative FFI call on
both sides of the boundary, and names the cryptography crates so you do not try
to re-derive them here. By the end you will be able to identify the JSON
contract of a voting FFI call and assert on `PirSnapshotResolver` behaviour.

The voting circuits themselves live upstream: the Cargo manifest pulls
`orchard` with the `unstable-voting-circuits` feature and `zcash_voting` 0.11
with `client-pir` + `client-tree-sync`.

```toml reference title="Cargo.toml"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Cargo.toml#L18-L18
```

```toml reference title="Cargo.toml"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Cargo.toml#L87-L92
```

## 2. Definitions

The following are named blocks. Where a concept has a typed Swift
representation, the type is named.

**Definition 15.1 (voting delegation).** Delegation is the precompute-then-prove
flow that lets a wallet's notes back a vote without revealing them. The Swift
entry points are `precomputeDelegationPir(...)` (network PIR lookup +
non-membership proof caching) and the proving call it precedes. The Rust side
is `rust/src/voting/delegation.rs`.

**Definition 15.2 (encrypted voting shares).** A vote weight is decomposed and
encrypted into shares. `encryptShares(roundId:shares:)` takes a `[UInt64]` of
shares, returns `[VotingWireEncryptedShare]`, and is backed by
`zcashlc_voting_encrypt_shares` in `rust/src/voting/vote.rs`.

**Definition 15.3 (share recovery).** Recovery persists and reloads the
intermediate state (transaction hashes, commitment bundles, Keystone
signatures) needed to resume or audit a vote. The Swift methods are in the
"Recovery state" section of `VotingRustBackend`; the Rust side is
`rust/src/voting/recovery.rs`.

**Definition 15.4 (voting rounds).** A round is the unit of a vote, with a
lifecycle phase. `VotingRoundPhase` is the typed state set:
`Initialized = 0`, `HotkeyGenerated = 1`, `DelegationConstructed = 2`,
`DelegationProved = 3`, `VoteReady = 4` (verified against
`round_phase_to_u32` in
[helpers.rs lines 74-84](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/voting/helpers.rs#L74-L84)
and the `FfiRoundState` doc at
[ffi_types.rs lines 14-15](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/voting/ffi_types.rs#L14-L15)).
Round lifecycle Swift methods are `initRound`, `getRoundState`, `listRounds`,
`getVotes`, `clearRound`; the Rust side is `rust/src/voting/rounds.rs`.

**Definition 15.5 (PIR snapshot resolution).** Each round has an expected
snapshot height. A delegation proof is bound to that snapshot, so the wallet
must query a PIR server serving exactly that snapshot. `PirSnapshotResolver`
probes the configured endpoints and selects one whose served height equals the
expected snapshot height exactly.

**Definition 15.6 (the tree-sync client).** The wallet keeps a local copy of
the vote nullifier tree in sync with a node, to produce witnesses for its notes.
The Swift methods are `syncVoteTree(roundId:nodeUrl:)`,
`generateVanWitness(...)`, and `resetTreeClient(...)`; the Rust side is
`rust/src/voting/tree.rs`. Tree-sync is enabled by the `client-tree-sync`
feature on `zcash_voting` (Cargo.toml line 89).

**Definition 15.7 (VotingNoteInfo).** The JSON wire shape of a note offered as
voting input. It is a `Codable` struct whose `CodingKeys` rename `ufvkStr` to
`ufvk_str` to match the Rust JSON. This is the payload `precomputeDelegationPir`
serializes.

**Stability caveat.** The voting circuits depend on the `orchard` crate's
`unstable-voting-circuits` feature. Per that crate's policy, `unstable-*`
features are excluded from the crate's semver guarantees: a minor or patch bump
of `orchard` may change or remove this API. Treat the voting subsystem as
pinned to the exact `orchard` and `zcash_voting` versions in `Cargo.toml`
(orchard 0.14, zcash_voting 0.11) and do not assume forward compatibility
across a bump.

## 3. The code

### The backend object and the database handle

`VotingRustBackend` holds an opaque `VotingDatabaseHandle` pointer and
serializes all handle access with an `NSLock`. Database-bound FFI calls hold the
lock for their full duration so `close()` cannot free the handle while Rust is
mid-call.

```swift reference title="Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift#L47-L57
```

The lock discipline is in the private helper `withHandle(_:)`, which every
database-bound call routes through. It throws `databaseNotOpen` if the handle
is nil, otherwise runs the operation while holding the lock.

```swift reference title="Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift#L1779-L1786
```

Errors cross the boundary the same way as the rest of the SDK: a sentinel
(here, a null `FfiBoxedSlice` pointer) plus a thread-local message read by
`staticLastErrorMessage`, which calls `zcashlc_last_error_length` /
`zcashlc_error_message_utf8` and clears the slot. See
[the Swift<->Rust bridge](./04-swift-rust-bridge.md) for the shared error
convention.

```swift reference title="Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift#L1874-L1888
```

### A representative JSON-in / JSON-out FFI call: encryptShares

`encryptShares` is the cleanest example of the voting FFI style. It encodes the
`[UInt64]` shares to JSON, hands the `(ptr, len)` to the C function inside
nested `withUnsafeBufferPointer` closures, and decodes the returned
`FfiBoxedSlice` JSON back into `[VotingWireEncryptedShare]`. On a null return it
reads the thread-local error message.

```swift reference title="Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift#L317-L342
```

The JSON decode is the shared private helper `decodeJSON(from:)`, which reads
`ptr.pointee.ptr` / `ptr.pointee.len` into `Data` and runs `JSONDecoder`.

```swift reference title="Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift#L1801-L1804
```

### The Rust side of encryptShares

`zcashlc_voting_encrypt_shares` is the matching `#[unsafe(no_mangle)] extern
"C"` function. Its body runs inside `catch_panic`, borrows the handle, parses
the `round_id` string and the `shares_json` `Vec<u64>` from the raw pointers,
calls `handle.db.encrypt_shares(...)`, maps the result to the JSON wire type,
and returns it via `json_to_boxed_slice`. On error it returns null
(`unwrap_exc_or_null`).

```rust reference title="rust/src/voting/vote.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/voting/vote.rs#L17-L54
```

This is the contract end to end: Swift encodes a JSON `[u64]`, Rust deserializes
to `Vec<u64>` (line 42), and Rust serializes `Vec<JsonWireEncryptedShare>` back
(lines 49-51), which Swift decodes as `[VotingWireEncryptedShare]`. The two
JSON shapes are the API; renaming a field on one side without the other breaks
silently at decode time.

### The shared Rust FFI helpers

Three helpers in `rust/src/voting/helpers.rs` define the byte-boundary contract
that every voting FFI input shares. `bytes_from_ptr` centralizes the null +
length check (a zero length returns an empty slice and ignores the pointer);
`str_from_ptr` delegates to it and validates UTF-8; `json_to_boxed_slice`
serializes any `Serialize` value into the `BoxedSlice` return type.

```rust reference title="rust/src/voting/helpers.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/voting/helpers.rs#L31-L59
```

A note on naming across the boundary: the Rust return type is
`crate::ffi::BoxedSlice`, and cbindgen renames `#[repr(C)]` voting structs with
an `Ffi*` prefix at the C header, which is why the Swift side calls it
`FfiBoxedSlice`. The `Ffi*`-prefixed `#[repr(C)]` voting structs are defined in
`rust/src/voting/ffi_types.rs` (for example `FfiRoundState`, `FfiVotingHotkey`).
See [the FFI build pipeline](./05-ffi-build-pipeline.md) for how cbindgen
generates the header these names come from.

### A delegation FFI call: precomputeDelegationPir

The delegation precompute is the call that ties PIR resolution to the FFI. The
Swift method first resolves a PIR endpoint via `PirSnapshotResolver`, then
serializes `roundId`, the `[VotingNoteInfo]` notes, and the resolved URL into
the FFI call.

```swift reference title="Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift#L132-L184
```

The Rust counterpart `zcashlc_voting_precompute_delegation_pir` parses the same
inputs (note the empty-`notes_json` special case at lines 448-452), connects to
the PIR client, runs `precompute_delegation_pir`, and returns the JSON result.

```rust reference title="rust/src/voting/delegation.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/voting/delegation.rs#L416-L472
```

The note payload these two functions exchange is `VotingNoteInfo`. Its
`CodingKeys` map the Swift `ufvkStr` to the JSON key `ufvk_str`; the rest of the
fields keep their names. This is the explicit JSON contract for a single note.

```swift reference title="Sources/ZcashLightClientKit/Rust/Voting/VotingTypes.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/Voting/VotingTypes.swift#L67-L104
```

### PIR snapshot resolution

`PirSnapshotResolver.resolve(endpoints:expectedSnapshotHeight:)` probes every
endpoint in parallel, filters to those reporting a height that matches the
expected snapshot exactly, and randomly selects one. It throws
`noEndpointsConfigured` on an empty list and `noMatchingEndpoint` if nothing
matches. The doc comment is explicit that the equality is strict, not `>=`,
because a server serving any other snapshot (behind or ahead) answers nullifier
queries against the wrong tree and yields a proof the chain rejects.

```swift reference title="Sources/ZcashLightClientKit/Rust/Voting/PirSnapshotResolver.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/Voting/PirSnapshotResolver.swift#L119-L159
```

The per-endpoint probe outcome is one of four statuses (`matching`,
`mismatched`, `missingHeight`, `unreachable`), and the default HTTP probe maps a
`GET <url>/root` response onto them.

```swift reference title="Sources/ZcashLightClientKit/Rust/Voting/PirSnapshotResolver.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/Voting/PirSnapshotResolver.swift#L44-L79
```

The selection branches:

- Precondition `endpoints` empty: throw `noEndpointsConfigured` (line 124).
- At least one endpoint reports `matching` (height equals expected): random
  pick among the matching set (lines 146-151).
- No `matching` endpoint: throw `noMatchingEndpoint` with the full per-endpoint
  diagnostics (lines 152-157).

## 4. Failure modes

- Stale PIR snapshot or wrong tree-state anchor for a round: querying a PIR
  server at a height other than the round's expected snapshot produces a
  delegation proof against the wrong nullifier tree, which the chain rejects.
  `PirSnapshotResolver` defends against this by requiring exact height equality.
  Caught by: `Tests/OfflineTests/PirSnapshotResolverTests.swift`
  (`testHeightAboveExpectedIsRejected` rejects an ahead height;
  `testAllMismatchedThrowsNoMatchingWithDiagnostics` rejects both behind and
  ahead) and `Tests/OfflineTests/VotingRustBackendTests.swift`
  (`test_precomputeDelegationPir_emptyEndpoints_throwsResolverError`).
- Mishandling the database handle or encrypted-share lifetime (freeing the
  handle while an FFI call is in flight): `withHandle` holds the lock across the
  full FFI call so `close()` blocks until the operation finishes. Caught by:
  `Tests/OfflineTests/VotingRustBackendTests.swift`
  (`test_close_waitsForInFlightDatabaseOperationBeforeFreeingHandle`, which
  asserts `close()` does not return while a locked operation is running, and
  that the backend reports `databaseNotOpen` afterwards).
- Calling a database-bound voting method before `open`: every such method routes
  through `withHandle`/`requireOpenDatabase` and throws `databaseNotOpen`.
  Caught by: `Tests/OfflineTests/VotingRustBackendTests.swift`
  (`test_encryptShares_beforeOpen_throwsDatabaseNotOpen`,
  `test_setWalletId_beforeOpen_throwsDatabaseNotOpen`).
- A JSON field-name mismatch between the Swift `Codable` type and the Rust JSON
  type (for example renaming `ufvk_str`): the payload still serializes but fails
  to decode on the other side; `encryptShares` surfaces this as
  `rustError("encrypt_shares failed")`. Caught by:
  `Tests/OfflineTests/VotingRustBackendTests.swift`
  (`test_encryptShares_afterOpen_propagatesRustError` asserts the rust error
  message contains `encrypt_shares failed`).
- Depending on `unstable-voting-circuits` across a semver bump of `orchard`:
  because the feature is excluded from orchard's semver guarantees, a minor or
  patch bump can change the circuit API and break the build or invalidate
  proofs. No automated test in this workspace guards against an upstream bump;
  caught by audit only (review the orchard/zcash_voting version pins in
  `Cargo.toml` before any dependency update). The Rust-side fixtures use
  `zcash_voting` with the `test-fixtures` feature
  ([Cargo.toml line 95](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Cargo.toml#L95-L95));
  `rust/src/voting/helpers.rs` has a `#[cfg(test)] mod tests`
  ([lines 172-242](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/voting/helpers.rs#L172-L242))
  covering the pointer-boundary helpers and seed derivation, and
  `rust/src/voting/test_helpers.rs` provides the test-only fixtures module
  (declared at
  [voting.rs lines 17-18](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/voting.rs#L17-L18)).

## 5. Spec pointers

- orchard crate (https://github.com/zcash/orchard), `unstable-voting-circuits`
  feature: the actual zero-knowledge voting circuits. This SDK does not
  implement them; it links the feature (Cargo.toml line 18) and exposes proving
  through the FFI. The `unstable-*` prefix marks it as outside the crate's
  semver guarantees.
- zcash_voting crate (https://docs.rs/zcash_voting), version 0.11 with
  `client-pir` and `client-tree-sync`: the voting protocol logic, PIR client,
  and tree-sync client (Cargo.toml lines 87-90). All voting Rust functions
  delegate to `zcash_voting` types (imported as `voting` throughout).
- vote-nullifier-pir (https://github.com/valargroup/vote-nullifier-pir): the PIR
  server whose `GET /root` API `PirSnapshotResolver` probes. The
  `RootInfo.height` field is the served snapshot height the resolver matches on
  (cited in the `PirSnapshotResolver.swift` file header, lines 1-18).
- ZIP 244 (https://zips.z.cash/zip-0244): the transaction sighash the voting
  PCZT path uses; referenced in code as the "ZIP-244 shielded sighash" at
  [util.rs line 165](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/voting/util.rs#L165-L165)
  and the `extractPcztSighash` doc in `VotingRustBackend.swift`. No standalone
  voting-protocol ZIP is referenced in the voting source at this pin; the
  protocol is defined by the `zcash_voting` crate cited above.
- See [the Swift<->Rust bridge](./04-swift-rust-bridge.md) for the shared
  `zcashlc_*` / `catch_panic` / sentinel-return / thread-local-error convention,
  and [the FFI build pipeline](./05-ffi-build-pipeline.md) for how cbindgen
  produces the `Ffi*`-prefixed C header the Swift side imports.

## 6. Exercises

1. Identify the JSON-in / JSON-out contract of `encryptShares`. Give the line
   range of the Swift method that encodes the input and decodes the output, and
   the line range of the Rust function that decodes the input and encodes the
   output. State, in one sentence each, what JSON type crosses the boundary in
   and out.

2. Read `Tests/OfflineTests/PirSnapshotResolverTests.swift`. Which test proves
   that a height strictly greater than the expected snapshot is rejected, and
   what `PirSnapshotProbeOutcome.Status` does it assert is recorded in the
   diagnostics? Separately, in `VotingRustBackendTests.swift`, which test proves
   that `close()` waits for an in-flight locked operation before freeing the
   handle?

3. Modify or assert. In `PirSnapshotResolverTests.swift`, add a test that
   constructs a `PirSnapshotResolver` with a stub probe returning a single
   endpoint whose status is `.missingHeight`, calls `resolve` with any expected
   height, and asserts it throws `PirSnapshotResolverError.noMatchingEndpoint`
   with that endpoint's status recorded as `.missingHeight` in the `details`.
   Run the test. (Hint: the existing tests show the stub-probe and
   error-destructuring pattern.)

### Answers in the code

- Exercise 1: Swift
  [`encryptShares`, VotingRustBackend.swift lines 317-342](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/Voting/VotingRustBackend.swift#L317-L342);
  Rust
  [`zcashlc_voting_encrypt_shares`, vote.rs lines 28-54](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/voting/vote.rs#L28-L54).
  In: a JSON array of `u64` shares. Out: a JSON array of `WireEncryptedShare`
  (Swift `[VotingWireEncryptedShare]`).
- Exercise 2:
  [`testHeightAboveExpectedIsRejected`, PirSnapshotResolverTests.swift lines 96-116](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/PirSnapshotResolverTests.swift#L96-L116)
  asserts `details.first?.status == .mismatched(height: 200)`. The handle-wait
  test is
  [`test_close_waitsForInFlightDatabaseOperationBeforeFreeingHandle`, VotingRustBackendTests.swift lines 140-184](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/VotingRustBackendTests.swift#L140-L184).
- Exercise 3: model your test on
  [`testAllMismatchedThrowsNoMatchingWithDiagnostics`, lines 118-125 onward](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/PirSnapshotResolverTests.swift#L118-L125)
  for the stub-probe + `noMatchingEndpoint` destructuring; the `.missingHeight`
  status is defined at
  [PirSnapshotResolver.swift lines 52-53](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/Voting/PirSnapshotResolver.swift#L52-L53).

## 7. Further reading

- `zcash_voting` crate documentation (https://docs.rs/zcash_voting): the
  authoritative description of the delegation, share, and tree-sync protocols
  this chapter wraps. Read it before changing any voting payload shape.
- `rust/src/voting/db.rs` and `rust/src/voting/recovery.rs`: the SQLite-backed
  persistence for round state and recovery material, the storage layer behind
  the "Recovery state" Swift methods.
