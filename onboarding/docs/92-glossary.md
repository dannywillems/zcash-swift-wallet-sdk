---
sidebar_position: 92
title: Glossary
description: 'Flat alphabetical reference for the domain abbreviations and terms used across ZcashLightClientKit, each anchored to a file at the pin.'
---

# Glossary

Each entry is one line plus a link to a file at the pin where the term is
defined or prominently used. This is a lookup table, not a tutorial; follow
the chapter cross-links for the full treatment. The fixed vocabulary follows
the authoring contract: "deshield" is the verb and "unshielded" the
adjective; "anchor" not "Merkle root" once introduced; the voting-related
features are "in maintenance" where the code says so, not "legacy".

- **anchor** -- A note commitment tree root fixed at a chosen height; a
  shielded spend proves its note was committed as of that anchor. Used in
  the Rust core's transaction-proposal path
  ([rust/src/lib.rs](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs)).

- **birthday** -- The block height at or before which a wallet has no funds,
  so scanning can start there. Modeled by the checkpoint type in
  [Sources/ZcashLightClientKit/Checkpoint/Checkpoint.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Checkpoint/Checkpoint.swift).
  See [checkpoints](./16-checkpoints.md).

- **CBP (CompactBlockProcessor)** -- The Swift actor that drives the sync
  state machine over ordered actions
  ([Sources/ZcashLightClientKit/Block/CompactBlockProcessor.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/CompactBlockProcessor.swift)).
  See [the compact block processor and actions](./07-compact-block-processor-and-actions.md).

- **compact block** -- A lightwalletd-served block stripped to the fields a
  light wallet needs for trial decryption. Modeled by `ZcashCompactBlock`
  ([Sources/ZcashLightClientKit/Entity/ZcashCompactBlock.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Entity/ZcashCompactBlock.swift)).
  See [download and filesystem storage](./08-download-and-filesystem-storage.md).

- **dataDb** -- The sqlite database holding wallet metadata and transaction
  history (Rust writes, Swift reads). Its URL is configured in
  [Sources/ZcashLightClientKit/Initializer.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Initializer.swift).
  See [persistence](./10-persistence.md).

- **deshield / unshielded** -- To deshield is to move funds from a shielded
  pool to the transparent pool; unshielded describes funds in the
  transparent pool. The shielding side of this is `proposeShielding` on the
  public protocol
  ([Sources/ZcashLightClientKit/Synchronizer.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer.swift)).

- **FFI** -- The foreign function interface between the Swift SDK and the
  Rust core. The DB-bound surface is `ZcashRustBackend`
  ([Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift)).
  See [the Rust core and FFI surface](./03-rust-core-ffi-surface.md).

- **FVK / UFVK / UIVK** -- Full Viewing Key, Unified Full Viewing Key, and
  Unified Incoming Viewing Key. `UnifiedFullViewingKey` and
  `UnifiedIncomingViewingKey` are declared in
  [Sources/ZcashLightClientKit/Model/WalletTypes.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/WalletTypes.swift).

- **IVK** -- Incoming Viewing Key; detects incoming notes without granting
  spend authority. The unified form (UIVK) lives in
  [Sources/ZcashLightClientKit/Model/WalletTypes.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/WalletTypes.swift).

- **lightwalletd** -- The gRPC server that delivers compact blocks and
  relays transaction submissions. The SDK abstraction is
  `LightWalletService`
  ([Sources/ZcashLightClientKit/Modules/Service/LightWalletService.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Modules/Service/LightWalletService.swift)).
  See [networking and gRPC](./11-networking-grpc.md).

- **Memo** -- An optional encrypted payload attached to a shielded output.
  Modeled by the `Memo` type
  ([Sources/ZcashLightClientKit/Model/Memo.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/Memo.swift)).

- **note** -- A shielded output: a spendable unit of value in a shielded
  pool. Sent notes are recorded as `SentNoteEntity`
  ([Sources/ZcashLightClientKit/Entity/SentNoteEntity.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Entity/SentNoteEntity.swift)).

- **nullifier** -- A value revealed when a note is spent, used by consensus
  to prevent double-spending without revealing which note was spent. Handled
  in the Rust core
  ([rust/src/lib.rs](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs)).

- **PCZT (Partially Created Zcash Transaction)** -- The intermediate
  transaction format passed between proposal, proving, signing, and
  extraction. Typed in
  [Sources/ZcashLightClientKit/Entity/Pczt.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Entity/Pczt.swift).
  See [transactions: proposal to broadcast](./13-transactions-proposal-to-broadcast.md).

- **PIR (Private Information Retrieval)** -- A retrieval scheme used by the
  voting module so a client can fetch data without revealing which item it
  asked for. Constants for it live in
  [rust/src/voting/constants.rs](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/voting/constants.rs).
  See [voting](./15-voting.md).

- **proposal** -- A server-independent description of the transactions
  needed to satisfy a transfer or shielding request. Modeled by `Proposal`
  ([Sources/ZcashLightClientKit/Model/Proposal.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/Proposal.swift)).

- **scan range / suggested scan ranges** -- A block range plus a priority;
  the Rust core suggests ranges so the wallet can scan out of order. Modeled
  by `ScanRange`
  ([Sources/ZcashLightClientKit/Model/ScanRange.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/ScanRange.swift)).
  See [scan, enhance, fetch](./09-scan-enhance-fetch.md).

- **spend before sync** -- The non-linear scan strategy: scan recent and
  high-priority ranges first so spendable notes are discovered before a full
  linear sync completes. Referenced in
  [Sources/ZcashLightClientKit/Block/Actions/UpdateSubtreeRootsAction.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/UpdateSubtreeRootsAction.swift).

- **subtree root** -- A commitment-tree subtree root served by lightwalletd
  so the wallet can build its tree state without every leaf. Fetched in
  [Sources/ZcashLightClientKit/Block/Actions/UpdateSubtreeRootsAction.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Block/Actions/UpdateSubtreeRootsAction.swift).

- **Sapling / Orchard / Sprout / transparent pools** -- The Zcash value
  pools. Sapling and Orchard are the active shielded pools, Sprout is the
  original shielded pool, and transparent is the unshielded (Bitcoin-style)
  pool. The SDK enumerates receiver pools in `ReceiverType`
  ([Sources/ZcashLightClientKit/Model/WalletTypes.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/WalletTypes.swift)).

- **UA (Unified Address)** -- A single address that encodes receivers for
  more than one pool. Modeled by `UnifiedAddress`
  ([Sources/ZcashLightClientKit/Model/WalletTypes.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/WalletTypes.swift)).

- **USK (UnifiedSpendingKey)** -- The spending key covering all of a
  wallet's pools. Declared in
  [Sources/ZcashLightClientKit/Model/WalletTypes.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/WalletTypes.swift).
  See [the Swift/Rust bridge](./04-swift-rust-bridge.md).

- **welding (ZcashRustBackendWelding)** -- The Swift protocol that defines
  the DB-bound FFI surface the SDK calls into; "welding" is the project's
  name for these bridge protocols
  ([Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift)).

- **XCFramework** -- The pre-built binary packaging of the Rust core
  (`libzcashlc.xcframework`) that SPM downloads or builds locally. Declared
  as the binary target in
  [Package.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Package.swift).
  See [the FFI build pipeline](./05-ffi-build-pipeline.md).

- **Zatoshi** -- The base unit of ZEC (1 ZEC = 100,000,000 Zatoshi).
  Modeled by `Zatoshi`
  ([Sources/ZcashLightClientKit/Model/Zatoshi.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/Zatoshi.swift)).

- **ZIP (Zcash Improvement Proposal)** -- A Zcash standards document. The
  SDK implements several; for example the ZIP-321 payment-request URI is
  handled in
  [Sources/ZcashLightClientKit/Transaction/TransactionEncoder.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/TransactionEncoder.swift).
