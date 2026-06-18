---
sidebar_position: 9
title: Scan, Enhance, and Fetch UTXOs
description: 'The middle of the sync pipeline: suggested scan ranges, trial decryption, transaction enhancement, UTXO fetching, and reorg-driven rewind.'
---

# Scan, Enhance, and Fetch UTXOs

## 1. Why this chapter exists

Downloading blocks (covered in
[download and filesystem storage](./08-download-and-filesystem-storage.md))
produces bytes on disk; this chapter covers what turns those bytes into
wallet state. Scanning runs trial decryption to find notes, enhancement
fetches full transactions and decrypts their memos, UTXO fetching
records transparent outputs, and a reorg sends the machine into a
rewind. These actions are thin Swift wrappers that delegate the work to
the Rust backend through `scanBlocks` and `suggestScanRanges`; if you do
not know what those two calls return and where their results are
consumed, you cannot reason about why blocks are scanned out of order or
why a sync rewinds. By the end you will be able to state what
`suggestScanRanges` returns and trace its first range into a
`SyncControlData` that drives download and scan.

## 2. Definitions

**Definition 2.1 (spend before sync).** Blocks are not scanned in a
single forward pass. The Rust backend returns a prioritized list of
ranges (the suggested scan ranges) so that ranges likely to contain
spendable notes (for example the chain tip and ranges around found
notes) are scanned before historic ranges. This is the
"spend before sync" strategy. The priorities are enumerated in
`ScanRange.Priority`.

```swift reference title="Sources/ZcashLightClientKit/Model/ScanRange.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/ScanRange.swift#L10-L31
```

The priority ordering (lines 12-19): `ignored` (0), `scanned` (10),
`historic` (20), `openAdjacent` (30), `foundNote` (40), `chainTip`
(50), `verify` (60). Higher raw values are scanned first.

**Definition 2.2 (suggested scan ranges).** `suggestScanRanges()` is a
Rust-backend call (see
[the Swift/Rust bridge](./04-swift-rust-bridge.md)) returning
`[ScanRange]`, each a half-open `Range<BlockHeight>` plus a `Priority`.
The Swift side consumes only the first range to seed one sync pass; the
call is `rustBackend.suggestScanRanges()` in
`ProcessSuggestedScanRangesAction.run` (line 29).

**Definition 2.3 (trial decryption / scanning).** Scanning a range
means asking the Rust backend to attempt decryption of every shielded
output in the range against the wallet's viewing keys, recording notes
and nullifiers it finds. The Swift entry point is
`BlockScanner.scanBlocks`, which calls `rustBackend.scanBlocks`. The
result of one Rust call is a `ScanSummary`.

```swift reference title="Sources/ZcashLightClientKit/Model/ScanSummary.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/ScanSummary.swift#L10-L14
```

`scannedRange` is half-open: `BlockScanner` reads
`scanSummary.scannedRange.upperBound - 1` as the last scanned height
(BlockScanner line 71).

**Definition 2.4 (enhancement).** After a note is found, the wallet
still needs the full transaction. Enhancement fetches each requested
transaction, decrypts its outputs and memos, and stores it. The work is
driven by `rustBackend.transactionDataRequests()`, which returns a list
of `TransactionDataRequest` cases the Swift side must satisfy
(`BlockEnhancer.enhance`, line 77).

**Definition 2.5 (UTXO fetching).** Transparent outputs are not found
by trial decryption; they are fetched per transparent address from
lightwalletd and inserted into the wallet via
`rustBackend.putUnspentTransparentOutput` (`UTXOFetcher.fetch`, lines
69-75).

**Definition 2.6 (reorg / rewind).** A chain reorg invalidates already
scanned blocks above the fork point. The SDK responds by rewinding: it
asks the Rust backend to rewind wallet state and deletes the cached
block files above the rewind height. The default rewind distance is
`ZcashSDK.defaultRewindDistance = 10` (ZcashSDK.swift line 118) and the
theoretical maximum reorg is `maxReorgSize = 100` (line 82).

## 3. The code

### 3.1 ProcessSuggestedScanRangesAction: seeding one pass

This action fetches the suggested ranges and consumes the first one. It
converts the half-open `Range<BlockHeight>` into the inclusive
bookkeeping the rest of the pipeline uses, builds a `SyncControlData`,
and sends the machine to `.download`.

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/ProcessSuggestedScanRangesAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/ProcessSuggestedScanRangesAction.swift#L27-L66
```

Branches:

- precondition `scanRanges.first != nil` (lines 37-60): take the first
  range, set `latestScannedHeight = range.lowerBound - 1` and
  `latestBlockHeight = range.upperBound - 1` (the half-open to
  inclusive conversion, lines 39-40), reset the enhanced/scanned/
  downloaded heights, and go to `.download`.
- precondition no ranges (lines 61-62): everything is scanned, so skip
  straight to `.txResubmission`.

This is where the answer to "where is `suggestScanRanges` consumed"
lives: only `scanRanges.first` is used per pass, so the loop at lines
33-35 is purely for metrics. The next pass re-queries and gets the next
prioritized range.

### 3.2 ScanAction.run: per-batch scan and continuity errors

`ScanAction` scans one batch (default `batchSize` 100), reports progress
from the wallet summary, and on a continuity error converts itself into
a rewind.

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/ScanAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/ScanAction.swift#L39-L119
```

The reorg detection is the important branch. When `scanBlocks` throws
`ZcashError.rustScanBlocks` and the message is a continuity error, the
action sets `requestedRewindHeight = batchRange.lowerBound - 10` and
transitions to `.rewind` (lines 106-110); otherwise it rethrows. The
classifier:

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/ScanAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/ScanAction.swift#L126-L132
```

A continuity error is one of three Rust messages: a parent-hash
mismatch, a height discontinuity, or a note commitment tree size
mismatch (lines 128-130). The `- 10` rewind distance here matches
`defaultRewindDistance`. `removeBlocksCacheWhenFailed` is `true` (line
37).

### 3.3 BlockScanner: the Rust scanBlocks loop

`BlockScanner.scanBlocks` loops, calling `rustBackend.scanBlocks` for
`scanningBatchSize` blocks at a time, advancing `lastScannedHeight` from
each `ScanSummary` until it reaches the target or stops making progress.

```swift reference title="Sources/ZcashLightClientKit/Block/Scan/BlockScanner.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Scan/BlockScanner.swift#L33-L87
```

Per iteration:

- it fetches the tree state at `startHeight - 1` from the service
  (line 61) and passes it as `fromState` to `rustBackend.scanBlocks`
  (line 63). The comment "Directly correlated with `BlockDownloader`
  ranges" (line 60) ties the scan range to the downloaded range.
- `scannedNewBlocks = previousScannedHeight != lastScannedHeight` (line 73) is the progress guard; the `repeat ... while` (line 84) exits when
  no new blocks were scanned, the task is cancelled, or the target is
  reached.

### 3.4 EnhanceAction.run: batching enhancement at 1000 blocks

Scanning runs per 100-block batch, but enhancement is expensive and is
gated to roughly every `enhanceBatchSize = 1000` blocks
(`ZcashSDK.DefaultEnhanceBatch`, ZcashSDK.swift line 94).

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/EnhanceAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/EnhanceAction.swift#L41-L96
```

The gate at line 75 runs enhancement when the range is non-empty and
either `forceEnhance` is set or at least `enhanceBatchSize` blocks have
been scanned since the last enhancement. `forceEnhance` (line 73)
ensures the final under-1000-block tail at the chain tip is still
enhanced. `decideWhatToDoNext` (lines 21-35) routes to `.clearCache`
when the scan has caught up to the tip, otherwise to `.txResubmission`
to continue the loop.

### 3.5 BlockEnhancer: per-request fetch with retry

`BlockEnhancer.enhance` reads the Rust backend's
`transactionDataRequests()` and satisfies each one. Each request is
retried up to `maxRetries = 5` times in-cycle; requests still failing
after that are logged and left for the next sync cycle rather than
aborting the whole enhancement.

```swift reference title="Sources/ZcashLightClientKit/Block/Enhance/BlockEnhancer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Enhance/BlockEnhancer.swift#L70-L100
```

This describes what the code does (not a judgement): the per-request
loop sets `var retry = true`, attempts the request, and on a thrown
error increments `retries` and loops; the post-loop retries that
exhaust `maxRetries` are reported and deferred (lines 185-194). The
three request cases:

- `.getStatus(txId)` (lines 101-116): fetch the transaction, then call
  `rustBackend.setTransactionStatus` for either the not-recognized or
  the fetched status.
- `.enhancement(txId)` (lines 117-135): fetch the transaction, and on
  success call `rustBackend.decryptAndStoreTransaction` with the raw
  bytes and mined height. This is the post-fetch write the recent retry
  logic protects.
- `.transactionsInvolvingAddress(tia)` (lines 137-184): stream the
  transparent-address txids via `service.getTaddressTxids`, filter by
  status, and decrypt-and-store each match.

At the end it returns the transactions found in the range via
`transactionRepository.find(in:limit:kind:)` (line 206).

### 3.6 FetchUTXOsAction and UTXOFetcher

`FetchUTXOsAction.run` is a thin shell over the fetcher; it reports the
result and advances to `.handleSaplingParams`.

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/FetchUTXOsAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/FetchUTXOsAction.swift#L20-L33
```

`UTXOFetcher.fetch` lists every account's transparent receivers,
streams their UTXOs from the service, and inserts each into the wallet
through Rust.

```swift reference title="Sources/ZcashLightClientKit/Block/FetchUnspentTxOutputs/UTXOFetcher.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/FetchUnspentTxOutputs/UTXOFetcher.swift#L34-L94
```

The insertion branch matters: a UTXO that
`rustBackend.putUnspentTransparentOutput` rejects is appended to
`skipped` and logged rather than aborting the fetch (lines 67-85), so
one bad output does not fail the whole batch. The result is a tuple
`(inserted, skipped)`.

### 3.7 RewindAction: undoing scanned state after a reorg

`RewindAction` consumes `requestedRewindHeight` (set by `ScanAction` on
a continuity error), rewinds Rust wallet state, then rewinds the
downloader and the on-disk block cache.

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/RewindAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/RewindAction.swift#L32-L59
```

Branches:

- precondition `requestedRewindHeight == nil` (lines 33-35): nothing to
  do, go to `.processSuggestedScanRanges`.
- `rewindToHeight` returns `.requestedHeightTooLow(safeHeight)` (lines
  43-50): retry the rewind at the safe height; if that also fails,
  throw `ZcashError.rustRewindToHeight`.

After Rust rewinds, the action rewinds the downloader (line 53) and
calls `downloaderService.rewind(to:)` (line 56), which deletes cached
block files above the rewind height (see
[download and filesystem storage](./08-download-and-filesystem-storage.md)).
It then re-derives scan ranges, closing the reorg loop.

### 3.8 UpdateSubtreeRootsAction: feeding the note commitment tree

Before scanning can start, the Rust backend needs the note commitment
tree subtree roots. `UpdateSubtreeRootsAction` streams sapling (then,
if supported, orchard) subtree roots from `service.getSubtreeRoots` and
stores them via `rustBackend.putSaplingSubtreeRoots` /
`putOrchardSubtreeRoots`.

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/UpdateSubtreeRootsAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/UpdateSubtreeRootsAction.swift#L27-L88
```

The presence of sapling roots is the signal that the server supports
spend before sync; only then are orchard roots fetched (lines 57-85). A
stream timeout is rethrown (lines 41-42); any other sapling-stream error
falls through to `.updateChainTip` (lines 43-45).

## 4. Failure modes

- Scanning a range that is not the first suggested range (for example
  caching the suggested ranges and reusing a stale one): the
  `SyncControlData` bounds no longer match what Rust expects, and the
  scan can desync from the suggested order. Caught by: the darkside
  sync tests in `Tests/DarksideTests/SynchronizerTests.swift` exercise
  end-to-end scan ordering against a controlled chain; offline
  coverage of the action itself is in
  `Tests/OfflineTests/CompactBlockProcessorActions/` (the
  download/rewind action tests).
- Not handling a reorg (treating a continuity error as fatal instead of
  rewinding): the wallet keeps invalid scanned state above the fork
  point. Caught by: `testBasicReOrg` and `testTenPlusBlockReOrg` in
  `Tests/DarksideTests/ReOrgTests.swift` (lines 100 and 117), which
  drive a small and a 10-plus block reorg, plus the deeper scenarios in
  `Tests/DarksideTests/AdvancedReOrgTests.swift`.
- Aborting the whole enhancement on one transaction's fetch failure
  instead of retrying then deferring: an unreachable transaction stalls
  every later request in the cycle. Caught by: `testBasicEnhancement`
  in `Tests/DarksideTests/TransactionEnhancementTests.swift` (line
  186).
- Failing the whole UTXO fetch when one
  `putUnspentTransparentOutput` is rejected, instead of skipping it: a
  single malformed output drops every transparent balance update.
  No automated test in this workspace covers the skip path directly;
  caught by audit only (the skip is at
  `UTXOFetcher.swift` lines 81-84).
- Forgetting the `forceEnhance` tail in `EnhanceAction` (line 73): the
  last under-1000-block window before the tip is never enhanced, so
  recent memos and statuses are missing. No automated test in this
  workspace isolates the tail case; caught by audit only.

## 5. Spec pointers

- Zcash Protocol Specification
  (https://zips.z.cash/protocol/protocol.pdf), the note commitment tree
  and incremental Merkle tree sections, explains why
  `UpdateSubtreeRootsAction` must feed subtree roots before scanning and
  why a tree-size mismatch (ScanAction line 130) is a continuity error.
- ZIP 307 light client protocol
  (https://zips.z.cash/zip-0307) describes trial decryption of compact
  outputs, which is what `rustBackend.scanBlocks` performs over the
  downloaded compact blocks.
- lightwalletd `GetSubtreeRoots` and `GetTaddressTxids`
  (https://github.com/zcash/lightwalletd, `walletrpc/service.proto`)
  are the RPCs behind `UpdateSubtreeRootsAction` and the
  `transactionsInvolvingAddress` enhancement branch.
- The scan and rewind work is implemented in librustzcash
  (https://github.com/zcash/librustzcash); `scanBlocks` and
  `suggestScanRanges` cross the bridge documented in
  [the Swift/Rust bridge](./04-swift-rust-bridge.md).

## 6. Exercises

1. Define what `suggestScanRanges` returns and identify every line in
   `ProcessSuggestedScanRangesAction.run` that consumes its result.
   (How many of the returned ranges are used per pass?)
2. Read `Tests/DarksideTests/ReOrgTests.swift` `testBasicReOrg` (lines
   100-115) and state the three heights it configures (mock latest,
   target latest, reorg height) and which darkside datasets it loads.
3. Modify code or add a test: in `ScanAction.isContinuityError`
   (`Sources/ZcashLightClientKit/Block/Actions/ScanAction.swift` lines
   126-132), the rewind on a continuity error uses
   `batchRange.lowerBound - 10`. Change the literal `10` to reference
   `ZcashSDK.defaultRewindDistance` (ZcashSDK.swift line 118) so the
   two cannot drift, and confirm `swift test --filter OfflineTests`
   still passes.

### Answers in the code

1. `suggestScanRanges()` returns `[ScanRange]` (each a
   `Range<BlockHeight>` plus `Priority`,
   `Sources/ZcashLightClientKit/Model/ScanRange.swift` lines 10-31).
   Only `scanRanges.first` is consumed per pass:
   `ProcessSuggestedScanRangesAction.swift` lines 37-60 use the first
   range; the loop at lines 33-35 is metrics only.
2. `Tests/DarksideTests/ReOrgTests.swift` lines 101-103: mock latest
   `663200`, target latest `663202`, reorg height `663195`; datasets
   `.beforeReOrg` and `.afterSmallReorg` (lines 108-109).
3. The continuity classifier and the `- 10` rewind are at
   `Sources/ZcashLightClientKit/Block/Actions/ScanAction.swift` lines
   108 and 126-132; `defaultRewindDistance = 10` is at
   `Sources/ZcashLightClientKit/Constants/ZcashSDK.swift` line 118.

## 7. Further reading

- `ScanAction` progress reporting (lines 75-105) shows how
  `getWalletSummary` scan and recovery progress are combined into the
  single `syncProgress` event surfaced to clients.
- For where these actions sit in the state machine and how
  `ActionContext` is mutated, see
  [the compact block processor and actions](./07-compact-block-processor-and-actions.md).
- The checkpoint that seeds the wallet birthday and the first scan
  range is covered in [checkpoints](./16-checkpoints.md).
