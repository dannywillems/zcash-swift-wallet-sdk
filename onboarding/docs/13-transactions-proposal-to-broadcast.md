---
sidebar_position: 13
title: 'Transactions: from Proposal to Broadcast'
description: 'How the SDK turns a spend request into a signed Zcash transaction: proposals, ZIP 317 fees, the PCZT multi-step flow, and the in-maintenance one-shot path.'
---

# Transactions: from Proposal to Broadcast

## 1. Why this chapter exists

Sending value is the one operation a wallet exists for, and it is the one place
where an off-by-one in the call sequence loses money or double-spends notes.
This chapter answers: what is a proposal, why does the SDK split a send into
several FFI calls, and where does the spending key enter. By the end you will
be able to trace a send from `Synchronizer.proposeTransfer` through the Rust
backend to a stored, signed transaction, and tell the two send paths apart: the
PCZT flow (propose, build PCZT, prove, sign, extract) and the in-maintenance
one-shot `createProposedTransactions(proposal:spendingKey:)`. The broadcast step
itself (racing endpoints, persisting retry plans) is the subject of
[the Broadcaster chapter](./14-broadcaster-multi-server-submission.md); this
chapter stops at the point where a signed transaction exists in the wallet DB.

## 2. Definitions

**Definition 2.1 (proposal).** A `Proposal` is a fee-and-input-selection plan,
not a transaction. The Rust core selects which notes and UTXOs to spend,
computes the fee per [ZIP 317](https://zips.z.cash/zip-0317), and returns a
serialized plan describing one or more steps. The Swift `Proposal` wraps the
generated `FfiProposal` and exposes only a transaction count and a total fee
(see Section 3). No proof, signature, or key is involved yet.

**Definition 2.2 (PCZT).** A Partially Created Zcash Transaction is the
serialized intermediate form of a transaction as it passes through roles:
Creator (build from proposal), Prover (add zero-knowledge proofs), Signer
(authorize with the spending key), and the finalizer that extracts and stores
the network-ready transaction. In this SDK `Pczt` is a plain `Data`
([`Entity/Pczt.swift`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Entity/Pczt.swift)).

**Definition 2.3 (Zatoshi).** The smallest unit of ZEC, modelled by the
`Zatoshi` type backing an `Int64`. The conversion is
$1\,\text{ZEC} = 10^{8}\ \text{zatoshi}$, encoded as the constant
`oneZecInZatoshi = 100_000_000`. Amounts are clamped to
$\pm 21{,}000{,}000 \times 10^{8}$ zatoshi.

**Definition 2.4 (memo).** A `Memo` is the optional ZIP 302 note attached to a
shielded output, at most 512 bytes. Transparent receivers cannot carry a memo,
so `proposeTransfer` requires `nil` for transparent recipients.

**Rule 2.5 (two send paths).** The repository exposes two ways to turn a
proposal into stored transactions:

- The PCZT path: `createPCZTFromProposal` -> `addProofsToPCZT` -> sign (caller
  or external signer) -> `extractAndStoreTxFromPCZT`. The spending key is only
  needed at the sign step, which can run outside the SDK (hardware signer).
- The one-shot path:
  `createProposedTransactions(proposal:usk:) -> [Data]`, where the Rust core
  builds, proves, signs, and stores in a single FFI call given the
  `UnifiedSpendingKey` directly. This path is in maintenance; new integrations
  use the PCZT path because it allows the spending key to stay off-device.

**Invariant 2.6 (proposal is bound to chain state).** A proposal selects
concrete inputs (notes / UTXOs) that existed at the height it was built. Once
the chain advances or those inputs are spent elsewhere, the proposal can fail
when authorized. A proposal is single-use input selection, not a reusable
template (see Section 4).

## 3. The code

### The public entry point: proposeTransfer

`Synchronizer.proposeTransfer` is the public protocol method. It returns a
`Proposal`, never a transaction.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer.swift#L190-L195
```

The sibling `proposeShielding` returns an optional `Proposal`: `nil` when the
transparent balance to shield is zero or below the threshold.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer.swift#L212-L217
```

The Synchronizer protocol does not declare a `sendTransaction` method. Sending
is split across `createProposedTransactions(proposal:spendingKey:)` (the
one-shot path, returning a stream of `TransactionSubmitResult`) and
`createTransactionFromPCZT(pcztWithProofs:pcztWithSigs:)` (the PCZT path). Both
appear in the protocol below.

```swift reference title="Sources/ZcashLightClientKit/Synchronizer.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer.swift#L230-L233
```

### The Proposal model

The Swift `Proposal` is a thin wrapper over `FfiProposal`. It exposes only what
a UI needs without re-parsing the plan: how many transactions and the total
fee. The total fee is summed across steps from each step's `feeRequired`.

```swift reference title="Sources/ZcashLightClientKit/Model/Proposal.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/Proposal.swift#L11-L30
```

`totalFeeRequired()` is where the ZIP 317 fee surfaces in Swift: the value was
computed inside the Rust core when the proposal was built; Swift only sums the
per-step `feeRequired` fields. The `testOnlyFakeProposal` factory builds an
invalid proposal for UI testing and is documented as never to be used in
production.

### The encoder protocol

`TransactionEncoder` is the SDK-internal surface the Synchronizer delegates to.
It declares the propose methods, the one-shot `createProposedTransactions`, the
ZIP 321 URI variant, and the `submit` / `isTransactionKnownToServer` helpers.

```swift reference title="Sources/ZcashLightClientKit/Transaction/TransactionEncoder.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/TransactionEncoder.swift#L21-L73
```

Note `submitError` in the `TransactionEncoderError` enum at the top of the
file: a server rejection carries a numeric code and a message, and that pair is
what the multi-endpoint submitter races on in
[the next chapter](./14-broadcaster-multi-server-submission.md).

### The concrete encoder: WalletTransactionEncoder

`WalletTransactionEncoder` is the only production conformer. Its propose methods
forward straight to the Rust backend and rewrap the returned `FfiProposal` in a
Swift `Proposal`.

```swift reference title="Sources/ZcashLightClientKit/Transaction/WalletTransactionEncoder.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/WalletTransactionEncoder.swift#L64-L78
```

The one-shot path is where the `UnifiedSpendingKey` enters this layer. Before
calling Rust, `ensureParams` checks the Sapling spend/output parameter files are
readable; without them, proving cannot run and the method throws
`walletTransEncoderCreateTransactionMissingSaplingParams`.

```swift reference title="Sources/ZcashLightClientKit/Transaction/WalletTransactionEncoder.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/WalletTransactionEncoder.swift#L107-L121
```

The returned `[Data]` are transaction ids; `fetchTransactionsForTxIds` reads
the now-stored transactions back out of the `dataDb` through the repository.

### The Rust boundary: the propose and PCZT welding methods

The propose, PCZT, and finalize calls all live on `ZcashRustBackendWelding`,
the DB-bound FFI surface ([see the bridge chapter](./04-swift-rust-bridge.md)).
`proposeTransfer` returns an `FfiProposal`; the doc comment ties it to ZIP 317
input selection and fee computation.

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift#L257-L262
```

The PCZT roles map one-to-one onto welding methods. `createPCZTFromProposal`
takes the account and the proposal and returns the unsigned, unproven PCZT. Its
doc comment carries the double-spend warning: do not call it in parallel for the
same proposal.

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift#L306-L316
```

`addProofsToPCZT` is the Prover role: it consumes a PCZT and returns one with
the zero-knowledge proofs attached. `PCZTRequiresSaplingProofs` (line 332) lets
a caller skip the Sapling parameter download when no Sapling proofs are needed.

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift#L334-L341
```

`extractAndStoreTxFromPCZT` is the finalizer. It takes the proven PCZT and the
separately signed PCZT, merges them, extracts the network transaction, and
stores it in the wallet, returning the 32-byte txid.

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift#L343-L352
```

### Where the spending key enters

The `UnifiedSpendingKey` is needed only to authorize (sign). In the one-shot
path it is passed straight to `zcashlc_create_proposed_transactions`:

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift#L1109-L1131
```

In the PCZT path the SDK never sees the key during create or prove
(`createPCZTFromProposal`,
[`ZcashRustBackend.swift#L344-L371`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift),
and `addProofsToPCZT`,
[`#L412-L440`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift)).
Signing happens between proving and `extractAndStoreTxFromPCZT`
([`#L443-L487`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift)),
which takes two PCZTs (proofs, signatures) and no key.

### Zatoshi

`Zatoshi` is the money type used throughout the propose APIs. The unit
constants and the clamp live at the top of the type.

```swift reference title="Sources/ZcashLightClientKit/Model/Zatoshi.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/Zatoshi.swift#L10-L37
```

The `@Clamped` wrapper on `amount` (line 28) means an out-of-range value is
silently clamped, not rejected; arithmetic uses plain `Int64` add/subtract
(lines 60-66) with no overflow guard beyond the clamp on assignment.

### Memo

`Memo` is the ZIP 302 enum. `asMemoBytes()` is the conversion the propose path
uses, and `intoMemo()` is the inverse parser keyed on the first byte.

```swift reference title="Sources/ZcashLightClientKit/Model/Memo.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/Memo.swift#L10-L45
```

The 512-byte cap is enforced in `MemoBytes.init(bytes:)`
([`#L121-L132`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/Memo.swift)),
which throws `memoBytesInputTooLong` past the capacity.

### The URI / EIP-681 path

`proposeFulfillingPaymentFromURI` (encoder line 85) handles ZIP 321 payment
URIs by forwarding to `proposeTransferFromURI` on the Rust backend
([`ZcashRustBackend.swift#L318-L341`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift)).
A separate, stateless backend parses EIP-681 (Ethereum-style) URIs:

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashEip681Backend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashEip681Backend.swift#L15-L29
```

This backend only parses and re-serializes request URIs (native and ERC-20); it
does not touch the wallet DB and does not build a Zcash proposal.

## 4. Failure modes

- Reusing a proposal after the chain moved. The inputs a proposal selected may
  be spent or no longer at the same height; authorizing then fails inside Rust.
  A proposal is single-use input selection (Invariant 2.6), not a template. No
  automated test in this workspace; caught by audit only.
- Calling `createPCZTFromProposal` twice in parallel for one proposal. Each call
  selects the same notes; finalizing both double-spends. The welding doc comment
  warns against this
  ([`ZcashRustBackendWelding.swift#L306-L316`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift)).
  No automated test in this workspace; caught by audit only.
- Submitting (or extracting) before proofs are added. `extractAndStoreTxFromPCZT`
  expects the proven PCZT as one of its two arguments
  ([`#L343-L352`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift));
  skipping `addProofsToPCZT` yields a transaction the network rejects. No
  automated test in this workspace; caught by audit only.
- Mishandling change or fee in UI. The proposal already encodes the fee
  (`totalFeeRequired()`,
  [`Proposal.swift#L25-L29`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/Proposal.swift));
  re-deriving or hard-coding a fee in the app diverges from what Rust actually
  charged. No automated test in this workspace; caught by audit only.
- Treating a created transaction with no raw bytes as submittable.
  `ZcashTransaction.Overview.encodedTransaction()` throws `notEncoded` when the
  overview has no raw bytes
  ([`WalletTransactionEncoder.swift#L177-L185`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Transaction/WalletTransactionEncoder.swift)).
  Caught by:
  [`Tests/OfflineTests/CreatedTransactionTests.swift`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/CreatedTransactionTests.swift#L24-L35)
  (`testInitFromOverviewWithoutRawThrowsNotEncoded`).

## 5. Spec pointers

- [ZIP 317](https://zips.z.cash/zip-0317): the conventional fee mechanism. This
  is the algorithm the Rust core runs when building a proposal; the per-step
  `feeRequired` the Swift `Proposal` sums is its output.
- [ZIP 321](https://zips.z.cash/zip-0321): the payment-request URI format that
  `proposeFulfillingPaymentFromURI` and `proposeTransferFromURI` parse.
- The [`pczt` crate](https://github.com/zcash/librustzcash/tree/main/pczt): the
  Rust implementation behind `createPCZTFromProposal`, `addProofsToPCZT`, and
  `extractAndStoreTxFromPCZT`. Read it to see the role separation in
  Definition 2.2.
- [ZIP 302](https://zips.z.cash/zip-0302): the memo field encoding that
  `Memo.intoMemo()` decodes by first byte.
- The [Zcash Protocol Specification](https://zips.z.cash/protocol/protocol.pdf),
  Section 7 (transaction encoding) and Section 4.13 (output ciphertexts /
  memos): the on-the-wire form `extractAndStoreTxFromPCZT` produces.
- [The Swift/Rust bridge chapter](./04-swift-rust-bridge.md) for how the welding
  methods cross the FFI; [the Broadcaster chapter](./14-broadcaster-multi-server-submission.md)
  for what happens to the stored transaction next.

## 6. Exercises

1. Trace the PCZT send sequence with line ranges. Starting from
   `Synchronizer.createPCZTFromProposal` in the protocol
   ([`Synchronizer.swift#L256`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Synchronizer.swift)),
   list the ordered welding methods called (create, prove, finalize) and the
   line range of each in `ZcashRustBackend.swift`. Where in the sequence is the
   signature added, and which method does NOT receive the spending key?
2. Identify where the fee is computed and where ZIP 317 enters. Name the Swift
   method that exposes the fee and the field it sums, then state in one sentence
   why the fee is not recomputed in Swift. Point at the file and line range.
3. Modify a test. In
   [`CreatedTransactionTests.swift`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/CreatedTransactionTests.swift),
   `makeTransaction` builds an overview with `fee: Zatoshi(10_000)`. Add a test
   that constructs a `Proposal` via `testOnlyFakeProposal(totalFee:)` and asserts
   `totalFeeRequired()` returns the value passed in (or, after reading the
   factory, explain why the current implementation does not, and which line is
   the bug). Run `swift test --filter OfflineTests`.

### Answers in the code

- Exercise 1: PCZT create at
  [`ZcashRustBackend.swift#L344-L371`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift),
  prove at
  [`#L412-L440`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift),
  finalize at
  [`#L443-L487`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift).
  Signing sits between prove and finalize; none of create / prove / finalize
  takes a `UnifiedSpendingKey` (only the one-shot
  [`createProposedTransactions`, `#L1109-L1131`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift)
  does).
- Exercise 2: `Proposal.totalFeeRequired()` summing `step.balance.feeRequired`,
  [`Proposal.swift#L25-L29`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/Proposal.swift).
- Exercise 3: the factory at
  [`Proposal.swift#L37-L44`](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Model/Proposal.swift)
  sets `balance.feeRequired = totalFee` on a local `balance` that is never
  attached to the returned `FfiProposal()` (it builds an empty proposal), so
  `totalFeeRequired()` returns zero regardless of the argument; the assignment on
  line 41 is the dead line.

## 7. Further reading

The librustzcash `zcash_client_backend` proposal types
(`zcash_client_backend::proposal`) define the step / balance fields the Swift
`Proposal` reads. The
[`pczt` crate README](https://github.com/zcash/librustzcash/tree/main/pczt)
walks the role model (Creator, Prover, Signer, Combiner, Spend Finalizer,
Transaction Extractor) in full.
