---
sidebar_position: 14
title: 'The Broadcaster and Multi-Server Submission'
description: 'How the SDK submits a signed transaction to several lightwalletd endpoints in parallel, persists a retry plan, and resubmits on the next sync.'
---

# The Broadcaster and Multi-Server Submission

## 1. Why this chapter exists

A transaction that is built and signed is worth nothing until a `lightwalletd`
relays it to the network, and a single endpoint can drop, stall, or censor it.
This chapter answers: how does the SDK get a transaction mined despite one bad
endpoint, how does it avoid re-sending something the user never released, and
why is an "already in mempool" rejection treated as a success. By the end you
will be able to trace a submission from `Broadcaster.submit` through the racing
`MultiEndpointSubmitter`, into the SQLite `SubmitPlanStore`, and back out
through `TxResubmissionAction` on the next sync. This is recent, actively
changing code (the MOB-1039 multi-server work); the behaviours below are stated
from the source as it stands at the pinned commit.

## 2. Definitions

**Definition 2.1 (Broadcaster).** The `Broadcaster` protocol separates
transaction creation and network submission from the broader sync lifecycle
owned by [the Synchronizer](./06-synchronizer-and-public-api.md). It creates
transactions without submitting them, submits one transaction to many endpoints
in parallel, and offers a sequential batch variant.

**Definition 2.2 (multi-endpoint racing submission).** A submission sends one
transaction to every endpoint in the list concurrently and resolves as soon as
the outcome is decided: first acceptance wins, or every endpoint responded and
none accepted, or the response timeout fired, or the caller cancelled. After a
win, the remaining in-flight submissions continue through a grace window for
best-effort propagation before being cancelled.

**Definition 2.3 (submit plan).** The list of endpoints a transaction was
submitted to, persisted so background retry knows where to retry. A stored plan
is one of `awaiting` (created but never submitted; skip it), `ready([endpoints])`
(submitted; retry through these), or `storeUnavailable` (the store could not be
read; skip rather than guess). The type:

```swift reference title="Sources/ZcashLightClientKit/Transaction/SubmitPlanStore.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/SubmitPlanStore.swift#L10-L20
```

**Definition 2.4 (resubmission loop).** On each sync the `TxResubmissionAction`
finds unmined, unexpired transactions and retries each through its recorded plan
(or the default endpoint for legacy transactions), throttled to once per five
minutes.

**Rule 2.5 (already-known is success).** When a submit RPC returns a non-zero
error code, the SDK asks the same `lightwalletd` whether it already has the txid
(`GetTransaction`). If the server reports the transaction is in mempool or
chain, the broadcast already landed and the result is reclassified as success.
This avoids depending on backend-specific error codes or message text (see
Section 3 and CHANGELOG MOB-1039).

**Invariant 2.6 (plan recorded before the network attempt).** The retry plan is
written to the store before any submission begins, so a cancelled or timed-out
race still leaves the intended endpoints behind for background retry. An empty
endpoint list records no plan and returns `.unreachable`.

**Invariant 2.7 (plans survive until expiry, not until mined).** A mined
transaction keeps its plan until its expiry height, so a reorg that un-mines it
still has the endpoints to retry through. A transaction with no expiry height is
never a resubmission candidate, so its plan is stale immediately.

## 3. The code

### The Broadcaster contract

The protocol exposes two create methods (one-shot and PCZT), a single-transaction
`submit`, and a batch `submit`. `submit` returns a `TransactionSubmissionOutcome`
rather than throwing.

```swift reference title="Sources/ZcashLightClientKit/Broadcaster.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Broadcaster.swift#L31-L78
```

The outcome enum names every terminal state. Read the doc comments: `.timedOut`
and `.cancelled` are explicitly "may still have been broadcast", not failure.

```swift reference title="Sources/ZcashLightClientKit/Broadcaster.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Broadcaster.swift#L154-L176
```

### SDKBroadcaster.submit

`SDKBroadcaster` is the production conformer. Its single-transaction `submit`
shows Invariant 2.6 directly: the empty-list short-circuit returns `.unreachable`
and records nothing; otherwise the plan is recorded before the race starts.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKBroadcaster.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKBroadcaster.swift#L52-L74
```

The batch `submit` is strictly sequential and stops at the first transaction
that is not `.accepted`, marking the rest `.notAttempted`. This prevents
broadcasting transaction N+1 (which may spend the change of N) when N was not
accepted.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKBroadcaster.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKBroadcaster.swift#L76-L104
```

### MultiEndpointSubmitter: the racing logic

`MultiEndpointSubmitter.submit` launches a worker `Task` that runs the race and
installs a cancellation handler that resolves `.cancelled` immediately, so a
straggler stuck in non-cancellable FFI cannot delay or override the caller's
cancellation.

```swift reference title="Sources/ZcashLightClientKit/Transaction/MultiEndpointSubmitter.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/MultiEndpointSubmitter.swift#L22-L60
```

The race itself is an actor, so every per-endpoint result is serialized and
arrival order decides ties. The `run` method adds one child task per endpoint
plus one timeout task, waits for the race to finish, then tears down.

```swift reference title="Sources/ZcashLightClientKit/Transaction/MultiEndpointSubmitter.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/MultiEndpointSubmitter.swift#L95-L121
```

The per-endpoint handler classifies the outcome by the thrown error: a
`submitError` is a server rejection (it carries the code and message), a
`CancellationError` (or any error while `Task.isCancelled`) is a cancellation,
and anything else is a transport failure.

```swift reference title="Sources/ZcashLightClientKit/Transaction/MultiEndpointSubmitter.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/MultiEndpointSubmitter.swift#L145-L160
```

`resolveIfAllFailed` is where "all endpoints failed" splits into `.rejected`
(at least one server rejection observed) versus `.unreachable` (only transport
failures):

```swift reference title="Sources/ZcashLightClientKit/Transaction/MultiEndpointSubmitter.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/MultiEndpointSubmitter.swift#L224-L235
```

### EndpointSubmitter: one transaction, one endpoint

`EndpointSubmitter` is the seam between the race and the network, and the mock
point for offline tests. The production `GRPCEndpointSubmitter` opens an
ephemeral connection per attempt, uses an isolated Tor client when Tor is
enabled (so one stalled endpoint cannot serialize the race), and maps a
non-zero `errorCode` to `submitError`.

```swift reference title="Sources/ZcashLightClientKit/Transaction/EndpointSubmitter.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/EndpointSubmitter.swift#L9-L67
```

### SubmitPlanStore: SQLite-persisted plans

The store is an actor over a single SQLite table `tx_submit_plans` keyed by
txid, with the endpoint list JSON-encoded. Writes are best-effort (failures are
logged and swallowed so persistence can never fail a send); reads fail safe
(`.storeUnavailable`, never silent fallback).

```swift reference title="Sources/ZcashLightClientKit/Transaction/SubmitPlanStore.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/SubmitPlanStore.swift#L44-L58
```

`markAwaitingSubmission` inserts an empty-endpoint row (`"[]"`) per txid; this
"awaiting" mark is what keeps background retry away from transactions the app
created but never submitted. If the mark cannot be written, the store fails
itself closed for the session so later lookups report `.storeUnavailable`.

```swift reference title="Sources/ZcashLightClientKit/Transaction/SubmitPlanStore.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/SubmitPlanStore.swift#L60-L99
```

`plan(for:)` is the read side and the place the three-way distinction is made:
no row returns `nil` (legacy transaction), an empty or undecodable list returns
`.awaiting`, a non-empty list returns `.ready`, and any read error returns
`.storeUnavailable`.

```swift reference title="Sources/ZcashLightClientKit/Transaction/SubmitPlanStore.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/SubmitPlanStore.swift#L101-L123
```

`wipe()` drops the connection and deletes the file rather than just deleting
rows, so txids and endpoints are not recoverable from SQLite free pages after a
wallet wipe
([`SubmitPlanStore.swift#L158-L170`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/SubmitPlanStore.swift)).

### SubmitPlanExecutor: gentle background retry

The executor tries the recorded endpoints sequentially, stopping at the first
acceptance. Unlike the foreground race it does not fan out: background retry
stays gentle.

```swift reference title="Sources/ZcashLightClientKit/Transaction/SubmitPlanExecutor.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/SubmitPlanExecutor.swift#L11-L42
```

### TxResubmissionAction.run

`TxResubmissionAction` is one of the ordered
[CompactBlockProcessor actions](./07-compact-block-processor-and-actions.md). Its
`run` prunes stale plans, finds resubmission candidates, and resubmits at most
once per five minutes (the `thresholdToTrigger`). The per-transaction `do/catch`
ensures one transaction's dead endpoints cannot starve the others.

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/TxResubmissionAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/TxResubmissionAction.swift#L34-L86
```

The `resubmit` helper is where the plan kinds branch: `.awaiting` and
`.storeUnavailable` are skipped, `.ready` retries through the executor, and `nil`
(legacy) uses the default-endpoint encoder submit.

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/TxResubmissionAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/TxResubmissionAction.swift#L92-L121
```

Note `latestResolvedTime` is seeded to the current wall-clock time at
construction (line 15), not zero; the CHANGELOG records that the previous
zero-init made the five-minute throttle a no-op on first invocation, which could
re-broadcast a freshly-submitted transaction during the first sync cycle.

### Already-in-mempool reclassification

Rule 2.5 lives on the Synchronizer, not the Broadcaster. `submitTransactions`
catches `submitError`, asks `isTransactionKnownToServer`, and turns a rejection
into success when the server already has the txid.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift#L485-L514
```

`isTransactionKnownToServer` is the verify-against-the-server call: it queries
`GetTransaction` and returns `true` unless the server reports `txidNotRecognized`
([`WalletTransactionEncoder.swift#L150-L162`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/WalletTransactionEncoder.swift)).
This is what the CHANGELOG calls verifying against the server rather than
matching error text.

## 4. Failure modes

- Dropping a transaction when one endpoint fails. The submitter must race the
  whole list and resolve on first acceptance, not abort on the first failure;
  `submissionSucceeded` resolves `.accepted` while later endpoints keep going in
  the grace window
  ([`MultiEndpointSubmitter.swift#L173-L184`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/MultiEndpointSubmitter.swift)).
  Caught by:
  [`Tests/OfflineTests/BroadcasterTests.swift`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/BroadcasterTests.swift#L166-L185)
  (`testSubmitFirstAcceptanceWinsAcrossEndpoints`).
- Treating a benign "already in mempool" rejection as failure. The reclassify
  step at
  [`SDKSynchronizer.swift#L501-L511`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKSynchronizer.swift)
  exists to avoid showing a failure screen for an already-broadcast transaction.
  No automated test in this workspace covers the `submitTransactions`
  reclassification path; caught by audit only (the `isTransactionKnownToServer`
  seam is exercised indirectly via the stub returning `false`).
- Resubmitting a transaction past expiry, or re-broadcasting one the user never
  released. `pruneStalePlans` drops plans once expired and the `.awaiting` /
  `.storeUnavailable` cases skip retry
  ([`TxResubmissionAction.swift#L92-L151`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/TxResubmissionAction.swift)).
  Caught by:
  [`Tests/OfflineTests/CompactBlockProcessorActions/TxResubmissionActionTests.swift`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/CompactBlockProcessorActions/TxResubmissionActionTests.swift#L84-L99)
  (`testAwaitingTransactionIsSkipped`),
  [`#L125-L167`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/CompactBlockProcessorActions/TxResubmissionActionTests.swift)
  (`testPruningRemovesExpiredMissingAndNilExpiryPlansButKeepsMinedUntilExpiry`),
  and `testStoreUnavailableSkipsResubmission`
  ([`#L168-L183`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/CompactBlockProcessorActions/TxResubmissionActionTests.swift)).
- Recording no plan, or the wrong plan, before the race. An empty list must
  record nothing and return `.unreachable`. Caught by:
  [`BroadcasterTests.swift#L187-L197`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/BroadcasterTests.swift)
  (`testSubmitWithEmptyEndpointsIsUnreachableAndRecordsNoPlan`) and
  [`#L134-L151`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/BroadcasterTests.swift)
  (`testSubmitRecordsPlanAndDeliversToEndpoint`).
- A failing recorded endpoint exhausting retry without raising. The executor
  must try the next endpoint and throw the last error only when all fail. Caught
  by:
  [`Tests/OfflineTests/SubmitPlanExecutorTests.swift`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/SubmitPlanExecutorTests.swift#L40-L61)
  (`testTriesNextEndpointAfterFailure`, `testThrowsLastErrorWhenAllEndpointsFail`).

## 5. Spec pointers

- The [`lightwalletd`](https://github.com/zcash/lightwalletd) service: the
  `SendTransaction` RPC is what `GRPCEndpointSubmitter` calls, and
  `GetTransaction` is what `isTransactionKnownToServer` queries for Rule 2.5.
  See the service definition and the wallet protocol doc in that repo.
- The [Zcash Protocol Specification](https://zips.z.cash/protocol/protocol.pdf),
  Section 7.1 (transaction expiry, `nExpiryHeight`): the field that decides when
  a plan is stale (Invariant 2.7).
- The repository `CHANGELOG.md` MOB-1039 entries describe the Broadcaster
  redesign, the persisted retry plan, the reclassify-against-the-server change,
  and the `latestResolvedTime` throttle fix; read them alongside `MIGRATING.md`
  for the breaking API change from the single-endpoint `submit(_:to:)`.
- [The transactions chapter](./13-transactions-proposal-to-broadcast.md) for how
  the `CreatedTransaction` reaching this chapter was built and signed;
  [the actions chapter](./07-compact-block-processor-and-actions.md) for where
  `TxResubmissionAction` sits in the sync state machine.

## 6. Exercises

1. Trace persistence and retry across two files with line ranges. Starting at
   `SDKBroadcaster.submit`
   ([`SDKBroadcaster.swift#L52-L74`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKBroadcaster.swift)),
   identify the exact line that writes the plan, then in
   `TxResubmissionAction.resubmit` identify the line that reads it back and the
   line that retries through `SubmitPlanExecutor`. State which plan kind reaches
   the executor.
2. Read the test doubles and a submission test. Open
   [`Tests/TestUtils/SubmissionTestDoubles.swift`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/TestUtils/SubmissionTestDoubles.swift)
   and describe what `EndpointSubmitterMock.Behavior.hangUncancellable` simulates
   and why it exists. Then read `testSubmitFirstAcceptanceWinsAcrossEndpoints`
   and state which endpoint the assertion expects to win and why ordering does
   not guarantee it.
3. Modify a test and assert. In
   [`SubmitPlanExecutorTests.swift`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/SubmitPlanExecutorTests.swift),
   add a test that gives the executor two endpoints where the first is
   `.failTransport` and the second `.succeed`, and assert via
   `EndpointSubmitterMock.recordedSubmissions()` that both were attempted in
   order and the call did not throw. Run `swift test --filter OfflineTests`.

### Answers in the code

- Exercise 1: plan written at
  [`SDKBroadcaster.swift#L69`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer/SDKBroadcaster.swift)
  (`recordPlan`), read back at
  [`TxResubmissionAction.swift#L93`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/TxResubmissionAction.swift)
  (`plan(for:)`), retried at
  [`#L106`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/TxResubmissionAction.swift);
  only `.ready` reaches the executor.
- Exercise 2: `hangUncancellable` is defined at
  [`SubmissionTestDoubles.swift#L150-L152`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/TestUtils/SubmissionTestDoubles.swift)
  and implemented at
  [`#L200-L205`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/TestUtils/SubmissionTestDoubles.swift);
  the winning-endpoint assertion is at
  [`BroadcasterTests.swift#L180`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/BroadcasterTests.swift)
  (the rejecting endpoint returns code -25, so only the accepting one can win
  regardless of arrival order).
- Exercise 3: the existing
  [`testTriesNextEndpointAfterFailure`, `SubmitPlanExecutorTests.swift#L40-L48`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/SubmitPlanExecutorTests.swift)
  is the template; the executor loop it exercises is
  [`SubmitPlanExecutor.swift#L25-L35`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/SubmitPlanExecutor.swift).

## 7. Further reading

`Tests/OfflineTests/EndpointSubmitterTests.swift` exercises the gRPC submitter
against an in-process `RecordingCompactTxStreamerService`, which is the closest
this workspace gets to an integration test of the submission path without a
live `lightwalletd`. Reading it shows how `errorCode` maps to `submitError` and
how a transport failure differs from a server rejection at the boundary.
