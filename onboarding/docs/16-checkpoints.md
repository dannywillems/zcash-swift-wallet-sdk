---
sidebar_position: 16
title: Checkpoints and Wallet Birthday
description: 'How bundled checkpoint JSON files seed a wallet birthday and let a new wallet skip scanning history before its creation height.'
---

# Checkpoints and Wallet Birthday

## 1. Why this chapter exists

A new wallet does not need to scan the entire chain from Sapling activation. It
starts from a "birthday" height, and to construct transactions from that point
it needs the note commitment tree state at that height. The SDK ships that tree
state as bundled JSON checkpoints, one file per height. This chapter explains
the `Checkpoint` struct and its fields, how `BundleCheckpointSource` selects the
nearest checkpoint at or below a requested height, and how mainnet/testnet are
kept separate. By the end you will be able to read the checkpoint JSON schema,
add a checkpoint, and explain the nearest-below selection rule the tests pin.

## 2. Definitions

**Definition 16.1 (checkpoint).** A checkpoint is a record of the chain state
at one block height that seeds a wallet's scan start. Verified against
`Checkpoint.swift` lines 28-34 and the JSON shape, it has five fields:

- `height: BlockHeight` (the block height; encoded as a string in JSON).
- `hash: String` (the block hash at that height).
- `time: UInt32` (the block time, in seconds since the Unix epoch).
- `saplingTree: String` (hex-encoded Sapling note commitment tree frontier at
  that height).
- `orchardTree: String?` (the Orchard tree frontier; optional, absent in JSON
  before NU5/Orchard activation for the network).

**Definition 16.2 (wallet birthday).** The wallet birthday is the height a
wallet begins scanning from: the latest chain height at the moment the wallet
key was created. The doc comment on `Checkpoint` (lines 10-19) defines it and
notes the worst case is Sapling activation (height 280000 on mainnet in the
comment's example). Blocks before the birthday are never scanned.

**Definition 16.3 (nearest-below selection).** Given a requested height, the
chosen checkpoint is the bundled checkpoint with the greatest height that is
`<= requested`. If none qualifies (the request is below the lowest bundled
checkpoint), the Sapling-activation checkpoint is used. This is implemented by
`bestCheckpointHeight(for:checkpointDirectory:)` filtering `$0 <= height`,
sorting, and taking `.last` (Checkpoint+helpers.swift lines 38-44).

**Invariant 16.4 (network isolation).** Mainnet and testnet checkpoints live in
separate bundle directories (`checkpoints/mainnet/` and `checkpoints/testnet/`)
and are selected by `NetworkType`. A `BundleCheckpointSource` is constructed for
one network and resolves only that network's directory.

## 3. The code

### The checkpoint struct and its decoder

`Checkpoint` is a five-field value type. The doc comment explains why
`saplingTree` is bundled: generating it from scratch requires processing every
block since activation, so precomputing it saves the user significant time.

```swift reference title="Sources/ZcashLightClientKit/Checkpoint/Checkpoint.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/Checkpoint.swift#L28-L34
```

The custom `Decodable` conformance has two non-trivial details. First, `height`
is decoded as a `String` and parsed to `Int` (the JSON stores it quoted), via
`getHeight(from:)`. Second, `orchardTree` uses `decodeIfPresent`, so a JSON file
without that key decodes to `nil`. Any decode failure is rethrown as
`ZcashError.checkpointDecode`.

```swift reference title="Sources/ZcashLightClientKit/Checkpoint/Checkpoint.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/Checkpoint.swift#L45-L73
```

### The JSON on disk

The lowest mainnet checkpoint (`419200.json`, Sapling activation) carries an
empty tree frontier (`"000000"`) and no `orchardTree` key, matching the
`decodeIfPresent` path. Note that `height` is a quoted string.

```json reference title="Sources/ZcashLightClientKit/Resources/checkpoints/mainnet/419200.json"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Resources/checkpoints/mainnet/419200.json#L1-L7
```

A post-Orchard-activation checkpoint includes the `orchardTree` field (and a
populated `saplingTree`). Compare the shape with the file above; the only
schema difference is the presence of `orchardTree`.

```json reference title="Sources/ZcashLightClientKit/Resources/checkpoints/mainnet/2987500.json"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Resources/checkpoints/mainnet/2987500.json#L1-L8
```

### The CheckpointSource protocol

`CheckpointSource` is the abstraction the rest of the SDK depends on for
checkpoints (also called TreeStates). It exposes the latest known checkpoint,
the birthday for a given height, and date/height estimation.

```swift reference title="Sources/ZcashLightClientKit/Checkpoint/CheckpointSource.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/CheckpointSource.swift#L12-L41
```

### BundleCheckpointSource: loading and selecting

`BundleCheckpointSource` is the concrete source backed by the bundled JSON. Its
initializer fixes the network and the Sapling-activation fallback checkpoint
(`Checkpoint.mainnetMin` or `.testnetMin`). `birthday(for:)` delegates to
`Checkpoint.birthday(with:checkpointDirectory:)` and falls back to the
activation checkpoint when no file matches.

```swift reference title="Sources/ZcashLightClientKit/Checkpoint/BundleCheckpointSource.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/BundleCheckpointSource.swift#L10-L32
```

The nearest-below selection lives in `Checkpoint+helpers.swift`.
`bestCheckpointHeight(for:checkpointDirectory:)` lists the directory, maps each
filename to its integer height, keeps only heights `<= height`, sorts, and
returns the last (greatest). `checkpoint(at:)` then loads and decodes that file,
rethrowing as `ZcashError.checkpointCantLoadFromDisk` on failure.

```swift reference title="Sources/ZcashLightClientKit/Checkpoint/Checkpoint+helpers.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/Checkpoint+helpers.swift#L24-L65
```

### Network selection

`CheckpointSourceFactory.fromBundle(for:)` is the entry point that constructs a
`BundleCheckpointSource` for a given `NetworkType`.

```swift reference title="Sources/ZcashLightClientKit/Checkpoint/CheckpointSourceFactory.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/CheckpointSourceFactory.swift#L10-L14
```

The actual directory URL per network comes from `BundleCheckpointURLProvider`,
which has separate iOS and macOS variants. The macOS variant resolves the
directory by asking `Bundle.module` for a known seed file (`419200.json` for
mainnet, `280000.json` for testnet) and stripping the filename, because the
macOS test bundle would not otherwise find the checkpoint resources.

```swift reference title="Sources/ZcashLightClientKit/Checkpoint/BundleCheckpointURLProvider.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/BundleCheckpointURLProvider.swift#L25-L58
```

## 4. Failure modes

- A malformed or unparsable checkpoint JSON: `JSONDecoder().decode` throws and
  `checkpoint(at:)` rethrows as `ZcashError.checkpointCantLoadFromDisk`
  ([Checkpoint+helpers.swift lines 57-65](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/Checkpoint+helpers.swift#L57-L65));
  a non-string `height` value throws `ZcashError.checkpointDecode` via
  `getHeight`. No automated test in this workspace exercises a corrupt JSON
  file directly; caught by audit only.
- Choosing a birthday below the lowest bundled checkpoint: selection returns the
  Sapling-activation checkpoint instead of crashing, because
  `bestCheckpointHeight` filters to `<= height` and the source falls back to
  `saplingActivation`. Caught by:
  `Tests/OfflineTests/CheckpointSourceTests.swift`
  (`test_startBirthdayIsGivenIfTooLow_Mainnet` and `_Testnet`, which request
  height 4 and expect the activation checkpoint).
- Mainnet/testnet mixup (resolving a height against the wrong network's
  directory): each `BundleCheckpointSource` is bound to one network at init, and
  the URL provider returns a per-network directory. Caught by:
  `Tests/OfflineTests/CheckpointSourceTests.swift` (the `_Mainnet` and
  `_Testnet` variants assert distinct expected hashes and trees per network).
- Wrong `orchardTree` presence relative to activation height (a pre-activation
  file with an `orchardTree`, or vice versa): Caught by:
  `Tests/OfflineTests/CheckpointSourceTests.swift`
  (`test_orchardTreeIsNotNilOnActivation_Mainnet` /
  `test_orchardTreeIsNilBeforeActivation_Mainnet`, which assert `orchardTree`
  is `"000000"` exactly at the activation height and `nil` one block below).

## 5. Spec pointers

- Zcash Protocol Specification (https://zips.z.cash/protocol/protocol.pdf): the
  note commitment tree (Sapling and Orchard) and network upgrade activation
  heights. The `saplingTree` / `orchardTree` fields are serialized frontier
  states of those trees; `orchardTree` is absent before Orchard activation,
  which is why the decoder uses `decodeIfPresent`.
- ZIP 207 / network upgrade ZIPs (https://zips.z.cash/zip-0200): activation
  heights determine when Orchard checkpoints begin carrying an `orchardTree`.
  The tests pin mainnet Orchard activation at height 1687104.
- See [scan, enhance, fetch](./09-scan-enhance-fetch.md): the birthday
  checkpoint determines the height at which scanning begins and supplies the
  tree state scanning resumes from.
- See [the Synchronizer and public API](./06-synchronizer-and-public-api.md):
  the `Initializer`/`prepare` flow consumes a birthday height to seed a new
  wallet, and `BlockHeight.ofLatestCheckpoint(network:)`
  ([Checkpoint.swift lines 93-95](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/Checkpoint.swift#L93-L95))
  gives the newest known checkpoint height.

## 6. Exercises

1. Find the checkpoint JSON schema fields. Open
   `Resources/checkpoints/mainnet/2987500.json` and list each top-level key.
   Then find the matching `CodingKeys` and stored properties in
   `Checkpoint.swift`. Which JSON key is decoded as a `String` and converted to
   an integer, and in which function? Which key is optional?

2. Read `Tests/OfflineTests/CheckpointSourceTests.swift`. Which test proves the
   nearest-below rule (a requested height that does not exactly match a bundled
   file resolves to the greatest bundled height below it)? State the requested
   height and the expected resolved height.

3. Modify or verify. Pick a height between two existing mainnet checkpoint
   filenames (for example a value strictly between two adjacent bundled
   heights). In `CheckpointSourceTests.swift`, add a test that calls
   `CheckpointSourceFactory.fromBundle(for: .mainnet).birthday(for:)` with that
   height and asserts the resolved `Checkpoint.height` equals the greatest
   bundled height at or below your input. Run the test to confirm
   nearest-below selection.

### Answers in the code

- Exercise 1: keys are `network`, `height`, `hash`, `time`, `saplingTree`, and
  (post-activation) `orchardTree`
  ([2987500.json](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Resources/checkpoints/mainnet/2987500.json#L1-L8)).
  `CodingKeys` and properties are at
  [Checkpoint.swift lines 28-43](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/Checkpoint.swift#L28-L43)
  (note `network` is in the JSON but not a `CodingKeys` case, so it is ignored).
  `height` is parsed from a string in
  [`getHeight(from:)`, lines 58-73](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/Checkpoint.swift#L58-L73);
  `orchardTree` is the optional key (line 52).
- Exercise 2:
  [`test_BirthdayGetsMostRecentCheckpointPrecedingTheGivenHeight_Mainnet`, lines 34-56](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/CheckpointSourceTests.swift#L34-L56):
  requested height `1340004`, expected resolved height `1340000`.
- Exercise 3: selection logic to confirm against is
  [`bestCheckpointHeight`, Checkpoint+helpers.swift lines 29-45](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/Checkpoint+helpers.swift#L29-L45)
  (`filter { $0 <= height }.sorted().last`).

## 7. Further reading

- `BundleCheckpointSource.estimateBirthdayHeight(for:)`
  ([lines 35-120](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/BundleCheckpointSource.swift#L35-L120))
  estimates a birthday height from a `Date` using average inter-checkpoint
  block intervals, then refines by loading candidate checkpoints. It is a good
  read for understanding how a date-based "when did I create this wallet"
  answer maps onto the discrete bundled heights.
