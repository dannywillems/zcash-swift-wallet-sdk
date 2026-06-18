---
sidebar_position: 6
title: The Synchronizer and the Public API
description: 'How Synchronizer, SDKSynchronizer, the closure/Combine adapters, Initializer, and the DI composition root form the public surface of the SDK.'
---

# The Synchronizer and the Public API

## 1. Why this chapter exists

Every client app talks to this SDK through one protocol:
`Synchronizer`. This chapter answers "what is the entry point, what
state can it report, and how does work done deep in the sync pipeline
surface to the UI?". If you do not know that `SDKSynchronizer` is a
class wrapping an actor-driven `CompactBlockProcessor`, that
`stateStream` is a `CurrentValueSubject`, and that
`Synchronizer/Dependencies.swift` is where the entire object graph is
wired, you will block the wrong thread, subscribe to the wrong stream,
or look for a dependency in the wrong file. By the end you will be able
to trace a state change from a `CompactBlockProcessor.Event` to a
`SynchronizerState` emission and to read a `register` line in the DI
container. The files you touch are
`Sources/ZcashLightClientKit/Synchronizer.swift`,
`Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift`, and
`Sources/ZcashLightClientKit/Synchronizer/Dependencies.swift`.

## 2. Definitions

**Definition 2.1 (Synchronizer).** The public protocol that defines the
SDK contract: lifecycle (`prepare`, `start`, `stop`), address
derivation, transaction proposal/creation, transaction queries, and the
three observation streams. It is declared at
`Sources/ZcashLightClientKit/Synchronizer.swift` lines 94-564. The
concrete implementation is `SDKSynchronizer`; `ClosureSynchronizer` and
`CombineSynchronizer` are thin adapters over the async/await surface.

**Definition 2.2 (SynchronizerState).** The value type reported to
callers as the current state of a sync attempt. It carries
`syncSessionID`, `accountsBalances`, the public `syncStatus`, an
internal `internalSyncStatus`, `latestBlockHeight`, and
`fullyScannedHeight`. See `Synchronizer.swift` lines 31-78. It is
`Equatable`, so duplicate emissions can be deduplicated by callers.

**Definition 2.3 (SyncStatus vs InternalSyncStatus).** There are two
status enums. `SyncStatus` (lines 669-730) is the public-facing enum
with cases `unprepared`, `syncing(Float, Bool)`, `upToDate`, `stopped`,
`error(Error)`. `InternalSyncStatus` (lines 732-788) is the
package-internal enum the SDK actually drives; it has an extra
`synced` and `disconnected` distinction. The mapping from internal to
public is `mapToSyncStatus()` at lines 852-869: `synced` maps to
`upToDate`, and `disconnected` maps to `error(.synchronizerDisconnected)`.
`SynchronizerState.init` computes `syncStatus` from `internalSyncStatus`
through this map (lines 64-77), so the two never drift.

**Definition 2.4 (ConnectionState).** The lightwalletd connection state
reported separately from sync status: `idle`, `connecting`, `online`,
`reconnecting`, `shutdown`. See `Synchronizer.swift` lines 13-28. It
changes via a `connectionStateChanged` event, not via the state stream.

**Definition 2.5 (SynchronizerEvent).** A discrete event (as opposed to
a state snapshot): `minedTransaction`, `foundTransactions`,
`storedUTXOs`, `connectionStateChanged`. See lines 80-90. Events flow on
`eventStream`; state snapshots flow on `stateStream`.

**Invariant 2.6 (actor concurrency model).** `SDKSynchronizer` is a
`public class` (not an actor), but the engine it drives,
`CompactBlockProcessor`, is a Swift `actor`. The synchronizer hops onto
that actor with `await` for all sync work, and pushes UI-visible
emissions through a serial `DispatchQueue` (`streamsUpdateQueue`). A
caller that has no structured concurrency of its own should hop to a
`@MainActor` context to consume the streams rather than blocking a
thread waiting on the actor. Blocking the calling thread on
`await blockProcessor.stop()` is explicitly avoided in `stop()` for this
reason (`SDKSynchronizer.swift` lines 243-260).

## 3. The code

### 3.1 The protocol: lifecycle methods

`prepare` is the first call any client must make. It optionally takes a
seed (needed only when DB migrations require it), a wallet birthday, a
`WalletInitMode`, an account name, and a key source.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer.swift#L141-L147
```

`start` begins syncing within the caller's scope; `stop` cancels all
jobs the instance created.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer.swift#L149-L158
```

`proposeTransfer` builds a `Proposal` for sending funds. It does not
create or broadcast a transaction. The proposal is the first step of the
flow covered in
[transactions: proposal to broadcast](./13-transactions-proposal-to-broadcast.md).

```swift reference title="Sources/ZcashLightClientKit/Synchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer.swift#L190-L195
```

The protocol has no method literally named `sendTransaction`. Sending is
two steps: build a proposal (`proposeTransfer` /
`proposeShielding` / `proposefulfillingPaymentURI`), then create and
submit the transactions for it with `createProposedTransactions`, which
returns a stream of per-transaction submit results.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer.swift#L230-L233
```

### 3.2 The protocol: observation streams

Three streams are exposed. `stateStream` is backed by a
`CurrentValueSubject`, so a new subscriber immediately receives the last
state. Synchronization progress is part of `InternalSyncStatus`, so this
stream emits many values; the doc comment recommends `throttle`.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer.swift#L104-L115
```

### 3.3 The implementation: SDKSynchronizer wiring

`SDKSynchronizer` is a class. It owns the two subjects backing the
streams and exposes them read-only as `AnyPublisher`. `stateStream`
comes from a `CurrentValueSubject` initialized to `.zero`; `eventStream`
comes from a `PassthroughSubject`.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift#L21-L30
```

The internal status is held in a `GenericActor<InternalSyncStatus>`, and
the comment on line 38 forbids reading or writing it directly:
callers use the async `status` getter and `updateStatus(_:)`. The block
engine is held as `blockProcessor: CompactBlockProcessor`.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift#L38-L45
```

At init time the synchronizer spins up a high-priority task that
subscribes to the processor's events. This is the hook that routes the
engine's progress into the public streams.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift#L127-L130
```

### 3.4 Routing CompactBlockProcessor events into the subjects

`subscribeToProcessorEvents` installs one `EventClosure` on the
processor (keyed `"SDKSynchronizer"`). Each `CompactBlockProcessor.Event`
case is mapped to a private handler. This is the single place where the
sync engine's output becomes SDK-visible state or events.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift#L294-L331
```

Two branches matter for the state-change trace:

- Precondition: the engine sends `.progressUpdated(syncProgress,
areFundsSpendable)`. Then `progressUpdated(_:_:)` builds a
  `.syncing` internal status and calls `updateStatus`.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift#L351-L354
```

- Precondition: the engine sends `.finished(height)`. Then `finished`
  refreshes scanned data and sets `.synced`, which maps to public
  `upToDate`.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift#L337-L341
```

`updateStatus` writes the actor-held internal status and then calls
`notify(...)`, which is what ultimately pushes a `SynchronizerState`
onto `stateSubject`. The property `updateStatus` enforces is that every
status change is logged and broadcast in one place.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift#L138-L142
```

### 3.5 prepare -> start lifecycle

`prepare` is idempotent against the `.unprepared` guard: if the status
is not `.unprepared` it returns `.success` immediately. It checks the
stored URL-parsing error, runs `Initializer.initialize` (which may
return `.seedRequired`), updates the latest-blocks provider, and moves
the status to `.disconnected` without emitting an external status
change.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift#L158-L189
```

`start` branches on the current status:

- Precondition `.unprepared`: throws `synchronizerNotPrepared`. You must
  `prepare` first.
- Precondition `.syncing`: logs a warning and re-enters
  `blockProcessor.start`; the processor de-duplicates concurrent starts.
- Precondition `.stopped` / `.synced` / `.disconnected` / `.error`:
  reads a wallet summary from Rust, computes a combined scan + recovery
  progress fraction, sets `.syncing(progress, areFundsSpendable)`, and
  starts the processor.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift#L193-L240
```

### 3.6 Initializer.initialize: the setup entry

`Initializer` is constructed first (paths, endpoint, Sapling params,
logging policy, Tor/exchange-rate flags) and stores any URL-parsing
error rather than throwing from the constructor (`Initializer.swift`
lines 164-215). The real work happens in `initialize`, called from
`prepare`: it creates on-disk storage, runs the Rust `initDataDb`
migration (which can return `.seedRequired`), resolves the birthday
checkpoint, and creates the first account if none exist.

```swift reference title="Sources/ZcashLightClientKit/Initializer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Initializer.swift#L433-L495
```

The constructor calls `Self.setup`, which calls `Dependencies.setup` to
populate the DI container. Sapling parameter source URLs
(`saplingParamsSourceURL`) are threaded through this setup and end up in
the `SaplingParametersHandler` registration (see 3.7). The mapping from
`LoggingPolicy` to a concrete `Logger` also happens here.

```swift reference title="Sources/ZcashLightClientKit/Initializer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Initializer.swift#L336-L347
```

### 3.7 Dependencies.swift: the DI composition root

`Dependencies.setup` is where almost every object the SDK uses is
registered against the `DIContainer`. Each `register(type:isSingleton:)`
takes a factory closure that resolves its own dependencies from the
container. Three representative registrations:

The Rust backend (the DB-bound FFI surface, see
[the Swift/Rust bridge](./04-swift-rust-bridge.md)) is a singleton built
from the wallet URLs and the chosen Rust log level.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/Dependencies.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/Dependencies.swift#L77-L89
```

The lightwalletd service is registered as a gRPC-over-Tor service (see
[networking: gRPC](./11-networking-grpc.md) and [Tor](./12-tor.md)).

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/Dependencies.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/Dependencies.swift#L121-L125
```

The transaction repository is a read-only SQLite DAO. The comment is a
hard rule: never set `readonly: false` here, because Rust owns writes to
the data DB (see [persistence](./10-persistence.md)).

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/Dependencies.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/Dependencies.swift#L127-L132
```

A second function, `Dependencies.setupCompactBlockProcessor` (lines
200-294), registers the per-action collaborators (`BlockDownloader`,
`BlockScanner`, `BlockEnhancer`, `UTXOFetcher`,
`SaplingParametersHandler`) consumed by the
[CompactBlockProcessor and its actions](./07-compact-block-processor-and-actions.md).

## 4. Failure modes

- Blocking a thread on a synchronizer call that hops to the
  `CompactBlockProcessor` actor (for example synchronously waiting for
  `stop()` to finish its inner `await blockProcessor.stop()`) defeats
  the fast-exit design at `SDKSynchronizer.swift` lines 243-260 and can
  deadlock the caller's run loop. Caught by: no automated test in this
  workspace; caught by audit only.
- Subscribing to `stateStream` and doing heavy work on every value
  without `throttle`: the stream emits a value on every progress tick
  (Definition 2.3), so per-value UI work starves the main thread. Caught
  by: no automated test in this workspace; caught by audit only.
- Reading `underlyingStatus` directly or mutating it outside
  `updateStatus(_:)`: bypasses the single notify path (3.4) so the
  public `stateStream` and the internal status diverge. Caught by: no
  automated test in this workspace; the comment at
  `SDKSynchronizer.swift` line 38 is the contract; caught by audit only.
- Calling `start` before `prepare`: throws `synchronizerNotPrepared`
  (3.5). Caught by:
  `Tests/OfflineTests/SynchronizerOfflineTests.swift`
  `testRefreshUTXOCalledWithoutPrepareThrowsError` (line 194) and
  `testRewindCalledWithoutPrepareThrowsError` (line 217), which exercise
  the same `throwIfUnprepared` guard for other entry points.
- Passing paths that fail alias rewriting: the constructor stores the
  error instead of throwing, and `prepare` surfaces it. Caught by:
  `Tests/OfflineTests/SynchronizerOfflineTests.swift`
  `testURLsParsingFailsInInitializerPrepareThenThrowsError` (line 252).

## 5. Spec pointers

- `docs/Architecture.md` in this repo: the high-level diagram of how the
  synchronizer sits above the processor and the Rust backend; read it
  alongside Definition 2.1 to place this chapter in the whole.
- Zcash Protocol Specification
  (https://zips.z.cash/protocol/protocol.pdf): the note-commitment and
  nullifier model that `SynchronizerState.fullyScannedHeight` gates on
  (the field doc at `Synchronizer.swift` lines 45-51 explains why a
  caller needing authoritative balance must gate on it).
- ZIP-321 (https://zips.z.cash/zip-0321): the payment URI format parsed
  by `proposefulfillingPaymentURI` (`Synchronizer.swift` lines 235-244).
- The lightwalletd repo (https://github.com/zcash/lightwalletd): the
  server the `LightWalletService` registration (3.7) connects to; its
  `GetLightdInfo` is what `ConnectionState` and server validation react
  to.

## 6. Exercises

1. Trace a state change end to end. Starting from
   `CompactBlockProcessor` emitting `.progressUpdated`, list the exact
   call chain (file + line ranges) that ends with a value on
   `stateSubject`. Identify each hop:
   `subscribeToProcessorEvents` -> `progressUpdated(_:_:)` ->
   `updateStatus(_:)` -> `notify(...)`.

2. List three registered services. Read
   `Sources/ZcashLightClientKit/Synchronizer/Dependencies.swift` and
   name three distinct types registered with `container.register`,
   giving the line range of each registration closure and whether it is
   a singleton.

3. (Code or test modification.) In
   `Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift`, add
   an injected-`logger` `info` line at the top of `progressUpdated(_:_:)`
   that logs the incoming `syncProgress`. Do not use `print`/`NSLog`
   (SwiftLint forbids them). Run `swift test --filter OfflineTests` and
   confirm the suite still builds and passes.

### Answers in the code

- Exercise 1: `SDKSynchronizer.swift` lines 294-331 (event routing),
  351-354 (`progressUpdated`), 138-142 (`updateStatus`). The final step
  is `notify(...)` at lines 1275-1310, where `latestState = newState`
  (line 1297) and `stateSubject.send(newState)` (line 1306) emit the
  `SynchronizerState`.
- Exercise 2: `Dependencies.swift` lines 77-89
  (`ZcashRustBackendWelding`, singleton), 121-125 (`LightWalletService`,
  singleton), 127-132 (`TransactionRepository`, singleton), among
  others between lines 22 and 197.
- Exercise 3: `SDKSynchronizer.swift` lines 351-354 is the method to
  edit; the injected logger is the `logger` property declared at line 33.

## 7. Further reading

- `Sources/ZcashLightClientKit/Synchronizer/ClosureSDKSynchronizer.swift`
  and `CombineSDKSynchronizer.swift`: the two adapter implementations.
  Each method delegates to the async `Synchronizer` API (see
  `ClosureSDKSynchronizer.swift` lines 11-23 for the design note), so
  the async surface is the one to extend first.
- [CompactBlockProcessor and the Action state machine](./07-compact-block-processor-and-actions.md):
  the engine whose events this chapter routes.
