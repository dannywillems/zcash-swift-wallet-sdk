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

The main RPC surface, read from the `LightWalletService` protocol:
`getInfo`, `latestBlock` / `latestBlockHeight`, `blockRange` (streaming),
`submit`, `fetchTransaction`, `fetchUTXOs` (streaming), `blockStream`
(streaming), `getSubtreeRoots` (streaming), `getTreeState`,
`getTaddressTxids` (streaming), and `getMempoolStream` (streaming).

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
service. `blockRange` maps to `GetBlockRange`, `submit` to `SendTransaction`,
`getSubtreeRoots` to `GetSubtreeRoots`, and so on. The `.proto` is in the repo
at the path below; it is excluded from the build and used only for code
generation.

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

## 7. Further reading

`fetchTransaction` in `LightWalletGRPCService.swift` (around lines 271-312) is
worth reading for how the SDK distinguishes "transaction not found" from a
real failure by string-matching the gRPC status message; the Tor path
(`TorLwdConn.fetchTransaction`) repeats the same logic, which
[chapter 12](./12-tor.md) discusses.
