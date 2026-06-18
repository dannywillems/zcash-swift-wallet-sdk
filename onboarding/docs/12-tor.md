---
sidebar_position: 12
title: 'The Tor Transport'
description: 'How lightwalletd traffic is optionally proxied through Tor with per-request circuit isolation and dormant modes.'
---

# The Tor Transport

## 1. Why this chapter exists

The SDK can route its lightwalletd traffic through Tor so that the network
observer of a wallet cannot trivially correlate its requests with an IP
address. The Tor runtime lives in the Rust core (`rust/src/tor.rs`, built on
arti) and is driven from Swift through `TorClient` and a
`LightWalletGRPCService` subclass. If you do not know how circuit isolation
and dormant mode work, you can accidentally reuse one circuit across unrelated
requests (defeating the privacy goal) or leave the runtime awake on a
backgrounded phone (burning CPU). By the end of this chapter you will be able
to point at the exact lines where an isolated circuit is created and where the
`ServiceMode` is forced to `.direct` when Tor is disabled.

## 2. Definitions

**Definition 2.1 (Tor transport).** When Tor is enabled, lightwalletd calls
are made through a Tor connection instead of a direct gRPC channel. The Swift
side wraps the gRPC service in `LightWalletGRPCServiceOverTor`; the Rust side
opens connections through arti.

**Definition 2.2 (circuit isolation).** Two Tor connections are "isolated"
when their streams never share a circuit, so an observer cannot link them. The
Rust `TorRuntime.isolated_client()` returns a handle that shares internal
state but uses separate circuits; `TorRuntime.connect_to_lightwalletd` opens
each lightwalletd connection on a fresh isolated client.

**Definition 2.3 (dormant mode).** A power state for the Tor client. `Normal`
keeps background tasks running; `Soft` puts them to sleep to conserve CPU on
mobile when the client is idle. `TorClient.sleep()` sets `Soft` and
`TorClient.wake()` sets `Normal`.

**Invariant 2.4 (Tor gates the service mode).** When Tor is not enabled,
`SDKFlags.ifTor(_:)` collapses any requested `ServiceMode` to `.direct`, so no
traffic is proxied. When Tor is enabled, `LightWalletGRPCServiceOverTor`
serves the Tor `ServiceMode` cases and delegates only `.direct` to the gRPC
superclass.

## 3. The code

### The SDKFlags Tor toggle

`SDKFlags` is the actor that holds `torEnabled` and the helper that enforces
Invariant 2.4. `ifTor(_:)` returns the requested mode only when Tor is on,
otherwise `.direct`.

```swift reference title="Sources/ZcashLightClientKit/Utils/SDKFlags.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Utils/SDKFlags.swift#L40-L49
```

### TorClient: the Swift handle

`TorClient` is an actor that owns an opaque pointer to the Rust `TorRuntime`.
`resolveRuntime()` lazily creates the runtime (and the Tor directory if
missing) by calling `zcashlc_create_tor_runtime`.

```swift reference title="Sources/ZcashLightClientKit/Tor/TorClient.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Tor/TorClient.swift#L48-L73
```

`isolatedClient()` wraps `zcashlc_tor_isolated_client`, returning a new
`TorClient` whose traffic will not share circuits with the parent.

```swift reference title="Sources/ZcashLightClientKit/Tor/TorClient.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Tor/TorClient.swift#L75-L115
```

That embed also shows `setDormant(mode:)` and the `sleep()` / `wake()`
helpers. `connectToLightwalletd(endpoint:)` opens a connection and returns a
`TorLwdConn`; it rejects endpoints containing embedded null bytes before
crossing into Rust.

```swift reference title="Sources/ZcashLightClientKit/Tor/TorClient.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Tor/TorClient.swift#L214-L232
```

`TorLwdConn.submit` and `TorLwdConn.getInfo` are the Tor counterparts of the
gRPC `submit` and `getInfo` from
[the networking chapter](./11-networking-grpc.md); `submit` parses the
`"Failed to submit transaction (code)"` string that the Rust side produces.

```swift reference title="Sources/ZcashLightClientKit/Tor/TorClient.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Tor/TorClient.swift#L250-L282
```

### LightWalletGRPCServiceOverTor: wrapping the gRPC service

`LightWalletGRPCServiceOverTor` subclasses `LightWalletGRPCService` and holds a
`ServiceConnections` actor that caches `TorLwdConn`s by mode. The
`connectToLightwalletd(_:)` method decides, per mode, whether to make a
one-shot `uniqueTor` connection, reuse the cached `defaultTor` connection, or
key into a named `torInGroup` connection.

```swift reference title="Sources/ZcashLightClientKit/Modules/Service/Tor/LightWalletGRPCServiceOverTor.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Modules/Service/Tor/LightWalletGRPCServiceOverTor.swift#L21-L55
```

Each overridden RPC has the same two branches: if `mode == .direct`, delegate
to the gRPC superclass; otherwise route over a `TorLwdConn` and, on error,
invalidate the cached connection via `responseToTorFailure`. `submit` is
representative.

```swift reference title="Sources/ZcashLightClientKit/Modules/Service/Tor/LightWalletGRPCServiceOverTor.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Modules/Service/Tor/LightWalletGRPCServiceOverTor.swift#L145-L156
```

### The Rust side: TorRuntime

`TorRuntime::create` builds an arti `Client` against the Tor directory; the
`dangerously_trust_everyone` flag relaxes the `fs-mistrust` permission check
on that directory. The arti dependencies are imported at the top of the file
(`tor_rtcompat::PreferredRuntime`, `zcash_client_backend::tor::{Client,
DormantMode}`).

```rust reference title="rust/src/tor.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/tor.rs#L34-L47
```

`isolated_client()` is where the per-request circuit isolation originates: it
clones the runtime and calls arti's `Client::isolated_client()`.

```rust reference title="rust/src/tor.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/tor.rs#L57-L74
```

`set_dormant` maps the FFI `TorDormantMode` to arti's `DormantMode`, and
`connect_to_lightwalletd` opens each lightwalletd connection on a freshly
isolated client.

```rust reference title="rust/src/tor.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/tor.rs#L76-L104
```

On the `LwdConn`, `get_latest_block` and `send_transaction` are the unary
calls behind `TorLwdConn.latestBlock` and `TorLwdConn.submit`.

```rust reference title="rust/src/tor.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/tor.rs#L157-L179
```

## 4. Failure modes

- Forgetting circuit isolation. Reusing one `TorLwdConn` across requests that
  should be unlinkable lets a network observer correlate them on a shared
  circuit; the design counters this by opening each connection on
  `isolated_client()`. Removing that isolation (for example caching one
  connection for everything) reintroduces correlation. No automated test in
  this workspace asserts circuit isolation; caught by audit only.
- Not setting dormant mode on mobile background. Leaving the runtime in
  `Normal` when the app is backgrounded keeps Tor background tasks running and
  drains CPU/battery; `sleep()`/`wake()` exist to avoid this. No automated
  test in this workspace; caught by audit only.
- fs-mistrust path-permission failure. If the Tor directory has permissions
  arti's `fs-mistrust` rejects and `dangerously_trust_everyone` is not set,
  `TorRuntime::create` fails and `TorClient` surfaces
  `ZcashError.rustTorClientInit`. No automated test in this workspace; caught
  by audit only.

## 5. Spec pointers

- [arti](https://gitlab.torproject.org/tpo/core/arti): the Rust Tor
  implementation that `rust/src/tor.rs` builds on; its `Client` and
  `DormantMode` types are imported directly (see `tor.rs#L13-L18`). Read its
  isolation and dormant-mode docs to understand the guarantees behind
  `isolated_client` and `set_dormant`.
- The `tor-rtcompat` crate (used via `PreferredRuntime` at `tor.rs#L7`):
  provides the async runtime arti runs on; relevant to how blocking calls are
  driven with `block_on`.
- [the networking chapter](./11-networking-grpc.md): the direct-gRPC transport
  this chapter alternates with; the `ServiceMode` enum that selects between
  them is defined there.

## 6. Exercises

1. Identify the exact function and line range in `rust/src/tor.rs` where an
   isolated Tor circuit handle is created, and explain in one sentence what it
   shares with its parent and what it does not.
2. Identify the field and the helper method in `SDKFlags.swift` that decide
   whether a requested `ServiceMode` is honored or forced to `.direct`.
3. (Modify/assert.) In a local Rust checkout, add a debug `tracing` line (use
   the existing `tracing` import, not `println!`) at the start of
   `connect_to_lightwalletd` recording the endpoint, rebuild the FFI per
   `docs/LOCAL_DEVELOPMENT.md`, and confirm the SDK still builds. Remove it
   afterward. This verifies you can locate and touch the Tor connection path.

### Answers in the code

1. `rust/src/tor.rs#L69-L74` (`isolated_client`): it shares `runtime` (cloned)
   and the client internals but uses separate circuits via
   `client.isolated_client()`.
2. The field is `torEnabled` (`SDKFlags.swift#L16`); the helper is
   `ifTor(_:)` (`SDKFlags.swift#L42-L44`), which returns `.direct` when
   `torEnabled` is false.
3. The function to edit is `connect_to_lightwalletd` at
   `rust/src/tor.rs#L93-L103`; the `tracing` crate is already in scope (see
   the `#[tracing::instrument]` on `create` at `tor.rs#L35`).

## 7. Further reading

`TorLwdConn.fetchTransaction` (`TorClient.swift#L289-L330`) mirrors the
gRPC "not found" string-matching from
[the networking chapter](./11-networking-grpc.md); reading both side by side
shows how the SDK keeps Tor and direct transports behaviorally equivalent.
