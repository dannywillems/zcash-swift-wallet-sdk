---
sidebar_position: 11
title: 'Networking: LightWalletService and gRPC'
description: 'How the SDK talks to lightwalletd over gRPC through the LightWalletService protocol and its generated stubs.'
---

# Networking: LightWalletService and gRPC

## 1. Why this chapter exists

Every block, transaction, and chain-tip query the SDK makes goes to a
`lightwalletd` server over gRPC. The SDK hides that behind one protocol,
`LightWalletService`, so the rest of the code never touches gRPC types
directly. If you do not know this boundary, you might hand-edit a generated
`.pb.swift` stub (which is overwritten on regeneration) or call into gRPC
from a layer that should be transport-agnostic. By the end of this chapter
you will be able to map a method in
`Sources/ZcashLightClientKit/Modules/Service/LightWalletService.swift` to the
RPC it calls in `LightWalletGRPCService.swift` and to the proto definition in
`proto/service.proto`.

## 2. Definitions

**Definition 2.1 (lightwalletd).** A server that indexes the Zcash chain and
serves compact blocks and related data to light clients over gRPC. The SDK is
a client of it; see [the lightwalletd repo](https://github.com/zcash/lightwalletd).

**Definition 2.2 (LightWalletService).** The Swift protocol that declares the
RPC surface the SDK depends on, in transport-neutral terms. The concrete gRPC
implementation is `LightWalletGRPCService`; the Tor-wrapping implementation is
covered in [the Tor transport](./12-tor.md).

**Definition 2.3 (generated stubs).** `service.pb.swift`,
`service.grpc.swift`, `compact_formats.pb.swift`, and `proposal.pb.swift` are
generated from the `.proto` files by protoc and the Swift gRPC plugin. The
`.proto` sources live at
`Sources/ZcashLightClientKit/Modules/Service/GRPC/ProtoBuf/proto/` and are
excluded from the build target (see `Package.swift` exclude list).

**Rule 2.4 (do not hand-edit generated code).** Do not edit `*.pb.swift` or
`*.grpc.swift`. Change the `.proto` and regenerate. Hand edits are lost on the
next regeneration and the SDK's `.swiftlint.yml` excludes these files for that
reason.

**Definition 2.5 (CompactTxStreamer).** `CompactTxStreamer` is the gRPC
service `lightwalletd` exposes (declared at `service.proto#L156-L212`). The
Swift gRPC plugin generates an async client for it,
`CompactTxStreamerAsyncClient`, which `LightWalletGRPCService` holds and is the
only type in the SDK that issues RPCs. Each method on `LightWalletService`
is implemented by calling one method on this client.

### The full CompactTxStreamer surface

The service declares 19 RPCs. The SDK calls 10 of them; the other 9 exist in
the generated client but are never invoked (they are served for other
`lightwalletd` clients such as full-wallet or block-explorer use). The table
below is the complete service, taken from `service.proto#L156-L212`, with the
generated client method and the `LightWalletService` entry point that drives
it on the direct gRPC path. "Kind" is the gRPC call shape: a server stream
yields many responses, a client stream sends many requests.

| Proto RPC                  | Request -> Response                                 | Kind          | Generated method           | Driven by (LightWalletService)                     |
| -------------------------- | --------------------------------------------------- | ------------- | -------------------------- | -------------------------------------------------- |
| `GetLatestBlock`           | `ChainSpec` -> `BlockID`                            | unary         | `getLatestBlock`           | `latestBlock`, `latestBlockHeight`                 |
| `GetBlock`                 | `BlockID` -> `CompactBlock`                         | unary         | `getBlock`                 | not used by this SDK                               |
| `GetBlockNullifiers`       | `BlockID` -> `CompactBlock`                         | unary         | `getBlockNullifiers`       | not used by this SDK                               |
| `GetBlockRange`            | `BlockRange` -> `CompactBlock`                      | server stream | `getBlockRange`            | `blockRange`, `blockStream`                        |
| `GetBlockRangeNullifiers`  | `BlockRange` -> `CompactBlock`                      | server stream | `getBlockRangeNullifiers`  | not used by this SDK                               |
| `GetTransaction`           | `TxFilter` -> `RawTransaction`                      | unary         | `getTransaction`           | `fetchTransaction`                                 |
| `SendTransaction`          | `RawTransaction` -> `SendResponse`                  | unary         | `sendTransaction`          | `submit`                                           |
| `GetTaddressTxids`         | `TransparentAddressBlockFilter` -> `RawTransaction` | server stream | `getTaddressTxids`         | `getTaddressTxids`                                 |
| `GetTaddressBalance`       | `AddressList` -> `Balance`                          | unary         | `getTaddressBalance`       | not used by this SDK                               |
| `GetTaddressBalanceStream` | `Address` -> `Balance`                              | client stream | `getTaddressBalanceStream` | not used by this SDK                               |
| `GetMempoolTx`             | `Exclude` -> `CompactTx`                            | server stream | `getMempoolTx`             | not used by this SDK                               |
| `GetMempoolStream`         | `Empty` -> `RawTransaction`                         | server stream | `getMempoolStream`         | `getMempoolStream`                                 |
| `GetTreeState`             | `BlockID` -> `TreeState`                            | unary         | `getTreeState`             | `getTreeState`                                     |
| `GetLatestTreeState`       | `Empty` -> `TreeState`                              | unary         | `getLatestTreeState`       | not used by this SDK                               |
| `GetSubtreeRoots`          | `GetSubtreeRootsArg` -> `SubtreeRoot`               | server stream | `getSubtreeRoots`          | `getSubtreeRoots`                                  |
| `GetAddressUtxos`          | `GetAddressUtxosArg` -> `GetAddressUtxosReplyList`  | unary         | `getAddressUtxos`          | not used by this SDK                               |
| `GetAddressUtxosStream`    | `GetAddressUtxosArg` -> `GetAddressUtxosReply`      | server stream | `getAddressUtxosStream`    | `fetchUTXOs`                                       |
| `GetLightdInfo`            | `Empty` -> `LightdInfo`                             | unary         | `getLightdInfo`            | `getInfo`                                          |
| `Ping`                     | `Duration` -> `PingResponse`                        | unary         | `ping`                     | not used (test-only; needs `--ping-very-insecure`) |

The "not used by this SDK" rows are still part of the generated client, so a
contributor adding a feature (for example a transparent balance query via
`GetTaddressBalance`) can call them without regenerating anything. Note also
that the SDK uses the streaming `GetAddressUtxosStream`, not the unary
`GetAddressUtxos`, and never uses the `*Nullifiers` block variants.

### Who implements these RPCs (lightwalletd, with zcashd backing)

`CompactTxStreamer` is implemented by `lightwalletd` (Go), not by `zcashd`.
`zcashd` is the C++ full node; it exposes a JSON-RPC interface and runs no
gRPC server, so the RPCs in the table above have no implementation in the
`zcashd` codebase. `lightwalletd` ingests blocks from `zcashd` into its own
store and serves the compact-block RPCs from there; only a few RPCs proxy a
live `zcashd` JSON-RPC call. The links below are the actual handler
implementations, pinned to `lightwalletd` v0.4.19 (commit `028401c`) and
`zcashd` v6.20.0 (commit `6966f30`).

| Proto RPC                  | lightwalletd handler (`frontend/service.go`)                                                                                                                                                                                                                                             | Direct zcashd JSON-RPC                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GetLatestBlock`           | [`GetLatestBlock`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L70-L90)                                                                                                                                                      | -                                                                                                                                                                                                                                                                |
| `GetBlock`                 | [`GetBlock`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L168-L189)                                                                                                                                                          | -                                                                                                                                                                                                                                                                |
| `GetBlockNullifiers`       | [`GetBlockNullifiers`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L193-L225)                                                                                                                                                | -                                                                                                                                                                                                                                                                |
| `GetBlockRange`            | [`GetBlockRange`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L230-L252)                                                                                                                                                     | -                                                                                                                                                                                                                                                                |
| `GetBlockRangeNullifiers`  | [`GetBlockRangeNullifiers`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L256-L295)                                                                                                                                           | -                                                                                                                                                                                                                                                                |
| `GetTransaction`           | [`GetTransaction`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L386-L423)                                                                                                                                                    | [`getrawtransaction`](https://github.com/zcash/zcash/blob/6966f30a8541b0e5998837dce14250ca9e15b16a/src/rpc/rawtransaction.cpp#L340)                                                                                                                              |
| `SendTransaction`          | [`SendTransaction`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L436-L490)                                                                                                                                                   | [`sendrawtransaction`](https://github.com/zcash/zcash/blob/6966f30a8541b0e5998837dce14250ca9e15b16a/src/rpc/rawtransaction.cpp#L1242)                                                                                                                            |
| `GetTaddressTxids`         | [`GetTaddressTxids`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L161-L164) -> [`GetTaddressTransactions`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L95-L156) | [`getaddresstxids`](https://github.com/zcash/zcash/blob/6966f30a8541b0e5998837dce14250ca9e15b16a/src/rpc/misc.cpp#L1070)                                                                                                                                         |
| `GetTaddressBalance`       | [`GetTaddressBalance`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L530-L537)                                                                                                                                                | -                                                                                                                                                                                                                                                                |
| `GetTaddressBalanceStream` | [`GetTaddressBalanceStream`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L540-L560)                                                                                                                                          | -                                                                                                                                                                                                                                                                |
| `GetMempoolTx`             | [`GetMempoolTx`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L581-L689)                                                                                                                                                      | [`getrawmempool`](https://github.com/zcash/zcash/blob/6966f30a8541b0e5998837dce14250ca9e15b16a/src/rpc/blockchain.cpp#L409), [`getrawtransaction`](https://github.com/zcash/zcash/blob/6966f30a8541b0e5998837dce14250ca9e15b16a/src/rpc/rawtransaction.cpp#L340) |
| `GetMempoolStream`         | [`GetMempoolStream`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L562-L568)                                                                                                                                                  | -                                                                                                                                                                                                                                                                |
| `GetTreeState`             | [`GetTreeState`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L301-L367)                                                                                                                                                      | [`z_gettreestate`](https://github.com/zcash/zcash/blob/6966f30a8541b0e5998837dce14250ca9e15b16a/src/rpc/blockchain.cpp#L1303)                                                                                                                                    |
| `GetLatestTreeState`       | [`GetLatestTreeState`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L369-L382)                                                                                                                                                | -                                                                                                                                                                                                                                                                |
| `GetSubtreeRoots`          | [`GetSubtreeRoots`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L813-L881)                                                                                                                                                   | [`z_getsubtreesbyindex`](https://github.com/zcash/zcash/blob/6966f30a8541b0e5998837dce14250ca9e15b16a/src/rpc/blockchain.cpp#L1457)                                                                                                                              |
| `GetAddressUtxos`          | [`GetAddressUtxos`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L798-L811)                                                                                                                                                   | -                                                                                                                                                                                                                                                                |
| `GetAddressUtxosStream`    | [`GetAddressUtxosStream`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L883-L892)                                                                                                                                             | -                                                                                                                                                                                                                                                                |
| `GetLightdInfo`            | [`GetLightdInfo`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L427-L433)                                                                                                                                                     | -                                                                                                                                                                                                                                                                |
| `Ping`                     | [`Ping`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go#L897-L910)                                                                                                                                                              | -                                                                                                                                                                                                                                                                |

A `-` in the last column means the handler issues no direct `zcashd` JSON-RPC
call: it answers from `lightwalletd`'s ingested block and mempool store (or
through internal helpers), and `lightwalletd` ingests that data from `zcashd`
out of band rather than per request. The line numbers above were read from the
pinned commits; `lightwalletd` and `zcashd` release on their own cadence, so
re-resolve them against a newer tag if the upstreams have moved.

### GetSubtreeRoots and GetTreeState vs the incremental Merkle tree

Two of the RPCs above, `GetSubtreeRoots` and `GetTreeState`, only make sense
once you know the data structure they describe: the note commitment tree.

**Definition 2.6 (note commitment tree).** Each shielded pool (Sapling,
Orchard) maintains one append-only Merkle tree of fixed depth 32. Its leaves
(level 0) are note commitments (`cmu` for Sapling, `cmx` for Orchard) appended
strictly left to right in chain order (block, then transaction, then output
index); a leaf's index from the left is its _position_. An internal node is
`parent = MerkleCRH(level, left, right)`, where Sapling uses a Pedersen-hash
combiner over Jubjub and Orchard uses Sinsemilla over Pallas; subtrees with no
leaves yet hash to precomputed per-level _empty roots_. The root taken over the
real leaves on the left and empty roots on the right, after the first `k`
leaves, is the _anchor_ a transaction proves membership against. It is an
_incremental_ Merkle tree: appending a leaf and recomputing the root needs only
the rightmost path, not every leaf. The Rust implementation is the
[`incrementalmerkletree`](https://dannywillems.github.io/incrementalmerkletree/)
crate, with `shardtree` layered on top; this SDK consumes both through the Rust
backend (see [scan, enhance, fetch](./09-scan-enhance-fetch.md)).

**Definition 2.7 (frontier, returned by GetTreeState).** The _frontier_ of an
incremental Merkle tree is the minimal node set needed to append the next leaf
and compute the current root: the most-recently-appended leaf plus, for each
level where the current position is a right child, the hash of its already
filled left sibling (an "ommer"). To append the next leaf you combine it upward
with those ommers where you are a right child and with empty-subtree roots
where the right side is still empty; to read the current root you hash the
frontier up against the empty roots. Its size is `O(depth)` (about 32 hashes)
whether the tree holds a thousand leaves or a hundred million, which is the
bandwidth win. `GetTreeState` (zcashd `z_gettreestate`) returns exactly this
for a
given block: `TreeState.saplingTree` and `TreeState.orchardTree`
(`service.proto#L112-L119`) are the hex-encoded commitment-tree frontiers as of
the end of that block, alongside `height`, `hash`, and `time`. A wallet started
at a birthday loads the frontier from its checkpoint's tree state so it can
build authentication paths for notes found _after_ that height without
replaying the tree from genesis. In `incrementalmerkletree` terms this is the
crate's frontier type (see
[the docs](https://dannywillems.github.io/incrementalmerkletree/)). The SDK
seeds this on the checkpoint/initialization path (see
[checkpoints](./16-checkpoints.md)).

**Definition 2.8 (shard and subtree root, streamed by GetSubtreeRoots).**
`shardtree` splits the depth-32 tree into fixed-height _shards_: complete
subtrees of height 16, each covering `2^16` = 65536 consecutive leaves (the
shard height is 16 for both pools in the `shardtree` / `zcash_primitives`
crates; the top `32 - 16 = 16` levels form the "cap"). A _subtree root_ is the
Merkle root of one completed shard, addressed in `incrementalmerkletree` by an
`Address` at level 16. `GetSubtreeRoots` (zcashd `z_getsubtreesbyindex`) streams
these completed shard roots: each `SubtreeRoot` (`service.proto#L131-L135`)
carries the 32-byte `rootHash` and the `completingBlockHash` /
`completingBlockHeight` of the block that filled the shard; the request
`GetSubtreeRootsArg` (`service.proto#L126-L130`) selects the pool
(`shieldedProtocol`), a `startIndex` (shard index), and `maxEntries`. Shard `i`
covers leaf positions `[i*2^16, (i+1)*2^16)`, the node at
`Address(level = 16, index = i)`, and its root is published only once the shard
is _completed_ (all 65536 leaves present). The last, still-filling shard at the
chain tip is therefore not in this stream: its state comes from the frontier
(`GetTreeState`) plus the leaves the wallet scans.

Together the two RPCs let a light wallet build the tree cheaply. It inserts the
streamed subtree roots into the _cap_ (the top 16 levels) to get the tree's
skeleton up to the tip, and seeds the frontier from its checkpoint's tree state
so its own appends land at the correct positions and the recomputed root
matches consensus. It then downloads leaf-level data (compact blocks) only for
the shard(s) holding its own notes: witnessing one note needs that shard's
leaves plus the roots of the sibling shards, not the other 65535 commitments in
the shard. This is the tree-sync half of "spend before sync." It is also
self-checking: the root the wallet recomputes from the cap roots, the frontier,
and its filled shard must equal the on-chain anchor, so a `lightwalletd` that
streams wrong subtree roots produces a witness against an anchor no block ever
had, and the resulting spend is rejected. The SDK feeds subtree roots to the
Rust backend via `putSaplingSubtreeRoots` / `putOrchardSubtreeRoots` (driven by
`UpdateSubtreeRootsAction`, see [scan, enhance, fetch](./09-scan-enhance-fetch.md)).

## 3. The code

### The service protocol

The protocol declares the RPC surface. The streaming RPCs return
`AsyncThrowingStream`; the unary RPCs are `async throws`. Note the `mode:
ServiceMode` parameter on every method: it selects direct gRPC versus Tor (see
[the Tor transport](./12-tor.md)).

```swift reference title="Sources/ZcashLightClientKit/Modules/Service/LightWalletService.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Modules/Service/LightWalletService.swift#L162-L207
```

`ServiceMode` is the enum that decides which connection a call uses.

```swift reference title="Sources/ZcashLightClientKit/Modules/Service/LightWalletService.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Modules/Service/LightWalletService.swift#L145-L160
```

### The endpoint and the factory

A `LightWalletEndpoint` (declared in `Initializer.swift`) carries host, port,
TLS flag, and per-call timeouts; the grpc-swift dependency is added in
`Package.swift` (`GRPC` from
[grpc-swift](https://github.com/grpc/grpc-swift)).

```swift reference title="Sources/ZcashLightClientKit/Initializer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Initializer.swift#L14-L19
```

`LightWalletServiceFactory.make()` builds the concrete `LightWalletGRPCService`
from an endpoint.

```swift reference title="Sources/ZcashLightClientKit/Modules/Service/LightWalletService.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Modules/Service/LightWalletService.swift#L137-L143
```

### The generated CompactTxStreamer client

`LightWalletGRPCService` holds the generated `CompactTxStreamerAsyncClient`
behind a lazily-connected accessor. The backing field is created on first use,
not at construction, so building the service does not open a socket.

```swift reference title="Sources/ZcashLightClientKit/Modules/Service/GRPC/LightWalletGRPCService.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Modules/Service/GRPC/LightWalletGRPCService.swift#L62-L65
```

`resolveLazyConnect()` builds the channel (`ClientConnection` with
platform-appropriate TLS when `secure`, insecure otherwise), attaches a
keepalive and the connectivity-state delegate, and wraps it in a
`CompactTxStreamerAsyncClient`. Every RPC method in the table above is called
on the instance this returns.

```swift reference title="Sources/ZcashLightClientKit/Modules/Service/GRPC/LightWalletGRPCService.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Modules/Service/GRPC/LightWalletGRPCService.swift#L143-L168
```

### gRPC methods mapped to RPCs

`blockRange` opens a server-streaming `getBlockRange` call and wraps each
response into a `ZcashCompactBlock`. The first branch guards `mode == .direct`:
the gRPC implementation refuses Tor modes (those are handled by the Tor
subclass in [chapter 12](./12-tor.md)). The second branch is the per-element
stream body, which maps any error to `ZcashError.serviceBlockRangeFailed`.

```swift reference title="Sources/ZcashLightClientKit/Modules/Service/GRPC/LightWalletGRPCService.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Modules/Service/GRPC/LightWalletGRPCService.swift#L235-L255
```

`submit` is a unary RPC: it wraps the raw transaction bytes into a
`RawTransaction` proto and calls `sendTransaction`. The same `mode == .direct`
guard applies.

```swift reference title="Sources/ZcashLightClientKit/Modules/Service/GRPC/LightWalletGRPCService.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Modules/Service/GRPC/LightWalletGRPCService.swift#L257-L269
```

### The proto service definition

The Swift methods correspond one-to-one to RPCs in the `CompactTxStreamer`
service; the complete mapping is the table in section 2 (`blockRange` ->
`GetBlockRange`, `submit` -> `SendTransaction`, `getSubtreeRoots` ->
`GetSubtreeRoots`, and so on). The `.proto` below is the authoritative source
for that table; it is excluded from the build and used only for code
generation. Read it alongside the table to see the per-RPC comments (for
example, the note that `GetTaddressTxids` returns transactions despite its
name).

```protobuf reference title="Sources/ZcashLightClientKit/Modules/Service/GRPC/ProtoBuf/proto/service.proto"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Modules/Service/GRPC/ProtoBuf/proto/service.proto#L156-L212
```

## 4. Failure modes

- Hand-editing a generated stub (`service.pb.swift`, `service.grpc.swift`).
  The edit is overwritten on regeneration and the file is SwiftLint-excluded,
  so the change is invisible to lint. No automated test in this workspace
  detects this; caught by audit only.
- Not handling stream cancellation. The streaming RPCs return
  `AsyncThrowingStream`; if a consumer stops iterating without the stream
  being torn down, the underlying gRPC call can leak. Caught by:
  `Tests/NetworkTests/BlockStreamingTest.swift` exercises streaming under a
  timeout (requires a network connection).
- Endpoint TLS or timeout misconfiguration. A wrong `secure` flag or too-low
  `singleCallTimeoutInMillis` / `streamingCallTimeoutInMillis` causes failed
  or timed-out calls. Caught by:
  `Tests/NetworkTests/LightWalletServiceTests.swift` (`testHundredBlocks`,
  `testLatestBlock`) connects to a live endpoint and would fail on a bad
  configuration; requires a network connection.

## 5. Spec pointers

- [the lightwalletd repo](https://github.com/zcash/lightwalletd): the server
  that implements the `CompactTxStreamer` service this chapter consumes; its
  proto is the upstream of the in-repo copy.
- [grpc-swift](https://github.com/grpc/grpc-swift): the gRPC runtime and code
  generator behind the `.grpc.swift` stubs; read its streaming-call docs to
  understand the `AsyncThrowingStream` wrapping.
- The in-repo proto sources
  (`Sources/ZcashLightClientKit/Modules/Service/GRPC/ProtoBuf/proto/`): the
  authoritative message and RPC definitions for this SDK build.
- [lightwalletd `frontend/service.go`](https://github.com/zcash/lightwalletd/blob/028401c4c4a7c8c386c81212324cc8083eed7510/frontend/service.go):
  the actual handler implementations of every `CompactTxStreamer` RPC (pinned
  to v0.4.19); the only place these gRPC RPCs are implemented.
- [zcashd `src/rpc/`](https://github.com/zcash/zcash/tree/6966f30a8541b0e5998837dce14250ca9e15b16a/src/rpc):
  the C++ JSON-RPC methods `lightwalletd` proxies for the RPCs that need live
  node data (`getrawtransaction`, `sendrawtransaction`, `z_gettreestate`,
  `z_getsubtreesbyindex`, `getaddresstxids`, `getrawmempool`); pinned to
  v6.20.0. zcashd has no gRPC server of its own.
- [`incrementalmerkletree` docs](https://dannywillems.github.io/incrementalmerkletree/):
  the frontier and subtree (`Address`) structures behind `GetTreeState` and
  `GetSubtreeRoots`; see Definitions 2.6 to 2.8.
- [the Tor transport](./12-tor.md) and
  [download and filesystem storage](./08-download-and-filesystem-storage.md):
  the consumers of the streaming block RPCs and the alternative transport.

## 6. Exercises

1. Map `LightWalletService.submit(spendTransaction:mode:)` to its
   implementation method and to the proto RPC and message it uses. Give all
   three line ranges.
2. Read `Tests/NetworkTests/LightWalletServiceTests.swift` and state how the
   `service` is constructed in `setUp` and what `testHundredBlocks` asserts
   about the streamed block count.
3. (Modify/assert.) In a local checkout with network access, add a test to
   `LightWalletServiceTests.swift` that calls `service.latestBlockHeight(mode:
.direct)` and asserts the returned height is greater than the testnet
   Sapling activation height; run the NetworkTests target and confirm it
   passes.
4. Using the table in section 2, list the nine `CompactTxStreamer` RPCs the
   SDK never calls, and confirm your list by grepping
   `LightWalletGRPCService.swift` for `compactTxStreamer.` and comparing the
   ten methods found against the 19 in `service.proto`.

### Answers in the code

1. Protocol: `LightWalletService.swift#L186`. Implementation:
   `LightWalletGRPCService.swift#L257-L269`. Proto RPC `SendTransaction`:
   `service.proto#L171`, taking a `RawTransaction` message.
2. `LightWalletServiceTests.swift#L22` builds the service via
   `LightWalletServiceFactory(endpoint: LightWalletEndpointBuilder.eccTestnet).make()`;
   `testHundredBlocks` (`LightWalletServiceTests.swift#L43-L53`) asserts
   `blocks.count == blockRange.count`.
3. The existing `testLatestBlock` at
   `LightWalletServiceTests.swift#L70-L72` shows the `latestBlockHeight(mode:)`
   call shape to model your new test on.
4. The ten called RPCs are the `compactTxStreamer.<method>` calls in
   `LightWalletGRPCService.swift` (`getLatestBlock`, `getLightdInfo`,
   `getBlockRange`, `sendTransaction`, `getTransaction`,
   `getAddressUtxosStream`, `getMempoolStream`, `getSubtreeRoots`,
   `getTreeState`, `getTaddressTxids`). The nine never called are `GetBlock`,
   `GetBlockNullifiers`, `GetBlockRangeNullifiers`, `GetTaddressBalance`,
   `GetTaddressBalanceStream`, `GetMempoolTx`, `GetLatestTreeState`,
   `GetAddressUtxos` (the unary variant), and `Ping`.

## 7. Further reading

`fetchTransaction` in `LightWalletGRPCService.swift` (around lines 271-312) is
worth reading for how the SDK distinguishes "transaction not found" from a
real failure by string-matching the gRPC status message; the Tor path
(`TorLwdConn.fetchTransaction`) repeats the same logic, which
[chapter 12](./12-tor.md) discusses.
