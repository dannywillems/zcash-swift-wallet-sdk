---
sidebar_position: 8
title: Block Download and Filesystem Storage
description: 'How compact blocks are streamed from lightwalletd, written to the on-disk cache by height-hash filename, and cleared after scanning.'
---

# Block Download and Filesystem Storage

## 1. Why this chapter exists

The sync pipeline cannot scan a block it has not downloaded, and it
cannot scan from a sqlite cache that no longer exists. Since version
0.18.x the compact block cache is a directory of files on disk, not a
sqlite `cacheDb` (see `MIGRATING.md`, lines 57-99). If you do not know
how blocks are named, batched, and cleared, you will write code that
either re-reads blocks that were already pruned or lets the cache grow
without bound. By the end of this chapter you will be able to point at
the exact line that builds a cached block's filename
(`FSCompactBlockRepository.filenameDescription`) and to state how
`DownloadAction.run` computes the per-batch download range.

## 2. Definitions

**Definition 2.1 (compact block).** A `ZcashCompactBlock` is the
SDK's value type for one compact block: a `height`, the serialized
protobuf `data`, and a `Meta` record (block hash, time, sapling output
count, orchard action count). The `Meta` is computed from the wire
`CompactBlock` protobuf when the value is constructed.

```swift reference title="Sources/ZcashLightClientKit/Entity/ZcashCompactBlock.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Entity/ZcashCompactBlock.swift#L20-L35
```

`BlockHeight` is a `typealias` for `Int` and `CompactBlockRange` is a
`ClosedRange<BlockHeight>`, both declared in the same file at lines
11-12. Ranges in this chapter are inclusive on both ends.

**Definition 2.2 (block cache filename).** Each cached block is one
file in the `blocks` subdirectory of the cache root. The filename is
`HEIGHT-BLOCKHASHHEX-compactblock`, joined by `-`. This is
`FSCompactBlockRepository.filenameDescription` (verified below), and
the convention is asserted by the test
`testWhenBlockIsStoredItFollowsTheFilenameConvention`
(`Tests/OfflineTests/FsBlockStorageTests.swift`, lines 77-100, which
checks for a file named `1234-<hash>-compactblock`).

**Definition 2.3 (download batch).** Downloading proceeds in batches.
The batch size comes from `Configuration.batchSize`, which defaults to
`ZcashSDK.DefaultBatchSize = 100`
(`Sources/ZcashLightClientKit/Constants/ZcashSDK.swift`, line 91). A
separate `downloadBufferSize = 100` (`CompactBlockProcessor.swift`,
line 71) controls how many blocks are held in memory before a flush to
disk.

**Invariant 2.4 (blocks live on disk, not in sqlite).** Compact blocks
are stored as files under the filesystem cache root.
`MIGRATING.md` (lines 57-61) states "Compact block cache no longer uses
a sqlite database" and that `Initializer` takes an `fsBlockDbRootURL`
RW directory. A companion metadata database (the FsBlockDb) tracks block
metadata and is written through the Rust backend; the block bytes
themselves are the files. Do not reintroduce a sqlite `cacheDb` for
block bytes.

**Rule 2.5 (the cache is internal).** `MIGRATING.md` (lines 94-99)
states clients must not read or rely on the cache contents. Treat the
`blocks` directory as a private implementation detail of the SDK.

## 3. The code

### 3.1 The repository protocol

Storage is abstracted behind `CompactBlockRepository`. Five operations:
`create`, `latestHeight`, `write`, `rewind(to:)`, `clear(upTo:)`, and
`clear()`.

```swift reference title="Sources/ZcashLightClientKit/Repository/CompactBlockRepository.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Repository/CompactBlockRepository.swift#L11-L43
```

The contract on `rewind(to:)` (lines 28-36) is precise: after
`rewind(to: 50)` with a max height of 100, the highest remaining block
is 49. `clear(upTo:)` (line 39) is the inclusive lower-side prune used
after a batch is scanned.

### 3.2 FSCompactBlockRepository: the filename scheme

`FSCompactBlockRepository` is the filesystem implementation. The
`blocksDirectory` is the `blocks` subdirectory of `fsBlockDbRoot`
(lines 21-23). A block's URL is its filename appended to that
directory:

```swift reference title="Sources/ZcashLightClientKit/Block/FilesystemStorage/FSCompactBlockRepository.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/FilesystemStorage/FSCompactBlockRepository.swift#L217-L227
```

The filename itself is built by `filenameDescription`, which joins
`height`, the hex of the block hash, and the literal `compactblock`
with `-`. This is the authoritative answer to "how is a cached block
named":

```swift reference title="Sources/ZcashLightClientKit/Block/FilesystemStorage/FSCompactBlockRepository.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/FilesystemStorage/FSCompactBlockRepository.swift#L171-L184
```

The reverse parse, `filenameToHeight` (lines 180-184), splits on `-`
and reads the first component as the height. `filenameComparison`
(lines 160-169) compares two filenames by their parsed heights, which
is how the directory listing is kept in ascending height order. The
`live` descriptor (lines 305-312) wires these three together and its
doc comment states the convention `HEIGHT-BLOCKHASHHEX-compactblock`.

### 3.3 Write: dedupe, atomic write, batched metadata

`write(blocks:)` iterates the input. For each block it computes the
URL, removes any existing file at that URL, writes the bytes
atomically, then flushes block metadata to the Rust-backed metadata
store every `storageBatchSize` (10) blocks, with a final flush for the
remainder.

```swift reference title="Sources/ZcashLightClientKit/Block/FilesystemStorage/FSCompactBlockRepository.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/FilesystemStorage/FSCompactBlockRepository.swift#L71-L110
```

Branches in the loop:

- precondition `blockExistsInCache(block)` true (lines 79-86): remove
  the stale file first, else `data.write(to:options:.atomic)` would
  still overwrite but the explicit remove keeps the path deterministic.
- precondition `savedBlocks.count % storageBatchSize == 0` (lines
  98-101): flush this batch of metadata to the FsBlockDb. The atomic
  write is provided by `FSBlockFileWriter.atomic` (lines 244-248).

`latestHeight()` (lines 67-69) delegates to the metadata store, which
calls `rustBackend.latestCachedBlockHeight()` (line 271). The metadata
store's live wiring is `FSMetadataStore.live` (lines 257-274): metadata
writes, rewinds, init, and latest-height all cross into Rust.

### 3.4 Clear and rewind on disk

`clear(upTo:)` lists the directory, filters filenames whose parsed
height is `<= height`, and removes those files.

```swift reference title="Sources/ZcashLightClientKit/Block/FilesystemStorage/FSCompactBlockRepository.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/FilesystemStorage/FSCompactBlockRepository.swift#L135-L145
```

`rewind(to:)` (lines 112-133) first rewinds the metadata store, then
removes every file whose height is strictly greater than `height` via
`filterBlockFiles` (lines 194-215). The asymmetry matters:
`clear(upTo:)` removes the lower already-scanned tail; `rewind(to:)`
removes the higher unscanned head after a reorg.

### 3.5 BlockDownloader: the streaming download actor

`BlockDownloaderImpl` is an actor implementing the `BlockDownloader`
protocol. The protocol documents the lifecycle: `setSyncRange` builds
the stream, `setDownloadLimit` caps the height, `startDownload` spawns
a detached task, and `waitUntilRequestedBlocksAreDownloaded` blocks
until a range is on disk.

```swift reference title="Sources/ZcashLightClientKit/Block/Download/BlockDownloader.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Download/BlockDownloader.swift#L26-L63
```

The core loop is `downloadAndStoreBlocks`. It pulls blocks from the
stream into an in-memory `buffer`; when the buffer reaches
`maxBlockBufferSize` it writes the buffer to storage and records the
new latest-downloaded height, then repeats, with a final flush after
the loop.

```swift reference title="Sources/ZcashLightClientKit/Block/Download/BlockDownloader.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Download/BlockDownloader.swift#L191-L219
```

`doDownload` (lines 101-182) decides whether to reuse the existing
gRPC stream or rebuild it. The stream is rebuilt when none exists, when
the range has advanced past `rebuildStreamAfterBatchesCount * batchSize`
(that constant is 3, line 67), or when the download target reaches the
stream's upper bound (lines 122-142). `waitUntilRequestedBlocksAreDownloaded`
(lines 273-284) polls the in-memory `latestDownloadedBlockHeight`
every 10 ms and rethrows any `lastError` recorded by the download task.

### 3.6 BlockDownloaderService: the thin service wrapper

`BlockDownloaderService` is a separate, simpler abstraction that pairs
the `LightWalletService` with a `CompactBlockRepository`. It is the
surface that the enhancer and UTXO fetcher reuse for transaction and
UTXO fetches (see [scan, enhance, fetch](./09-scan-enhance-fetch.md)),
and it owns `rewind(to:)` and `lastDownloadedBlockHeight`.

```swift reference title="Sources/ZcashLightClientKit/Block/Download/BlockDownloaderService.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Download/BlockDownloaderService.swift#L18-L53
```

Its `downloadBlockRange` (lines 96-107) buffers a whole range into
memory and writes once; this is the simple path, distinct from the
batched streaming `BlockDownloaderImpl` used by the sync pipeline.
`rewind(to:)` (lines 109-111) and `lastDownloadedBlockHeight` (lines
113-115) both delegate straight to `storage`.

### 3.7 DownloadAction: per-batch range computation

`DownloadAction` is the `Action` (see
[the processor and actions](./07-compact-block-processor-and-actions.md))
that drives the downloader for one batch. `run` computes the batch
range from the last scanned height and the latest block height, then
sets a download limit, starts the download, and waits for the batch.

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/DownloadAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/DownloadAction.swift#L32-L62
```

The batch sizing, line by line:

- `batchRangeStart = lastScannedHeight` and
  `batchRangeEnd = min(latestBlockHeight, batchRangeStart + config.batchSize)`
  (lines 41-42): one batch is at most `batchSize` (100) blocks, capped
  by the chain tip.
- `potentialDownloadLimit = batchRange.upperBound + (2 * config.batchSize)`
  (line 49): the downloader is allowed to run ahead by up to two extra
  batches, but only if the chain tip is far enough away
  (`latestBlockHeight >= potentialDownloadLimit`, line 50); otherwise
  the limit is just `batchRangeEnd`. This read-ahead lets download keep
  working while scan consumes earlier blocks.
- on success the action advances the state machine to `.scan` (lines
  23-26).

`removeBlocksCacheWhenFailed` is `true` (line 30): if download fails,
the processor wipes the block cache. `stop()` cancels the download
(lines 64-66).

### 3.8 ClearCacheAction and ClearAlreadyScannedBlocksAction

After a batch is scanned, `ClearAlreadyScannedBlocksAction` prunes the
already-scanned tail with `storage.clear(upTo: lastScannedHeight)` and
moves to `.enhance`:

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/ClearAlreadyScannedBlocksAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/ClearAlreadyScannedBlocksAction.swift#L20-L35
```

`ClearCacheAction` is the harder reset: it calls `storage.clear()`
(the whole directory) and returns the machine to
`.processSuggestedScanRanges`:

```swift reference title="Sources/ZcashLightClientKit/Block/Actions/ClearCacheAction.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/ClearCacheAction.swift#L18-L30
```

`storage.clear()` (FSCompactBlockRepository lines 147-156) removes the
entire `fsBlockDbRoot` and recreates it, which is why this action sends
the machine back to re-derive scan ranges from scratch.

## 4. Failure modes

- Removing the `ClearAlreadyScannedBlocksAction` prune (or never
  calling `clear(upTo:)`): the `blocks` directory grows for the whole
  sync because nothing deletes the scanned tail. `MIGRATING.md` (lines
  89-92) is explicit that the old sqlite cache grew to multiple
  gigabytes, which is the problem this prune avoids. Caught by:
  `testClearTheCache` and `testStoringTenSandblastedBlocksAndRewindFiveThenStoreThemBack`
  in `Tests/OfflineTests/FsBlockStorageTests.swift` (lines 278 and
  369).
- Reading a height range that was already cleared (for example asking
  the scanner to read below `lastScannedHeight` after a prune): the
  files are gone and the read finds nothing. Caught by:
  `testRewindDeletesTheRightBlocks` and
  `testRewindBlockSelectTheProperFilesByName` in
  `Tests/OfflineTests/FsBlockStorageTests.swift` (lines 102 and 232),
  which pin which files survive a rewind.
- Changing the filename scheme in `filenameDescription` without
  updating `filenameToHeight` / `filenameComparison`: the listing can
  no longer parse heights, so ordering, rewind, and clear all break.
  Caught by: `testWhenBlockIsStoredItFollowsTheFilenameConvention` and
  `testBlockDescriptorFiltersBlocksGreaterThan` in
  `Tests/OfflineTests/FsBlockStorageTests.swift` (lines 77 and 188).
- Misconfiguring the download batch size or download limit in
  `DownloadAction.run` (for example dropping the `2 * config.batchSize`
  read-ahead or inverting the `min`): download either stalls behind
  scan or over-downloads past the tip. Caught by: the action-level
  tests in `Tests/OfflineTests/CompactBlockProcessorActions/DownloadActionTests.swift`
  (`testDownloadAction_FullPass` line 16,
  `testDownloadAction_NoDownloadAndScanRange` line 102).

## 5. Spec pointers

- `MIGRATING.md` (lines 57-99) is the primary source for the cacheDb
  to filesystem migration and the reasoning for it; cite it whenever
  you touch the cache layout.
- lightwalletd compact block format
  (https://github.com/zcash/lightwalletd, the `walletrpc/compact_formats.proto`
  and `service.proto` files) defines the `CompactBlock` and the block
  streaming RPCs that `LightWalletService.blockStream` consumes; the
  `ZcashCompactBlock(compactBlock:)` initializer (Entity file lines
  55-67) maps that protobuf into the SDK type.
- Zcash Protocol Specification
  (https://zips.z.cash/protocol/protocol.pdf), the block and
  transaction structure sections, explains why a compact block carries
  only the output and action data needed for trial decryption rather
  than full transactions.

## 6. Exercises

1. State the exact filename scheme used for a cached block and give the
   file and line range that builds it. (Answer is a single function.)
2. Read `DownloadAction.run` and answer: for a default configuration,
   what is the largest height the downloader is permitted to fetch in
   one pass when the chain tip is far ahead, expressed in terms of
   `batchRangeEnd` and `config.batchSize`? Cite the line that computes
   it.
3. Modify a test: in
   `Tests/OfflineTests/FsBlockStorageTests.swift`, add an assertion to
   `testWhenBlockIsStoredItFollowsTheFilenameConvention` (lines 77-100)
   that the stored filename ends with `-compactblock`, and confirm it
   still passes with `swift test --filter OfflineTests`.

### Answers in the code

1. `FSCompactBlockRepository.filenameDescription`,
   `Sources/ZcashLightClientKit/Block/FilesystemStorage/FSCompactBlockRepository.swift`
   lines 171-178; the `live` descriptor doc comment at lines 305-307
   states `HEIGHT-BLOCKHASHHEX-compactblock`.
2. `Sources/ZcashLightClientKit/Block/Actions/DownloadAction.swift`
   lines 49-50: `potentialDownloadLimit = batchRangeEnd + 2 * batchSize`
   is used as the limit only when
   `latestBlockHeight >= potentialDownloadLimit`. With
   `DefaultBatchSize = 100` (ZcashSDK.swift line 91) that is
   `batchRangeEnd + 200`.
3. The convention is asserted at
   `Tests/OfflineTests/FsBlockStorageTests.swift` lines 93-99, where
   the expected filename is `"\(1234)-\(fakeBlockHash)-compactblock"`.

## 7. Further reading

- `Block/FilesystemStorage/FSCompactBlockRepository.swift` lines
  299-355: the `ZcashCompactBlockDescriptor` and
  `SortedDirectoryContentProvider` show how the directory is kept in
  ascending height order without relying on `FileManager`'s unspecified
  ordering.
- The next stage of the pipeline consumes these files: see
  [scan, enhance, and fetch UTXOs](./09-scan-enhance-fetch.md).
