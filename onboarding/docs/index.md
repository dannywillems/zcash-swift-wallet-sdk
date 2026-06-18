---
sidebar_position: 0
title: 'Overview: contributing to ZcashLightClientKit'
description: 'A code-anchored onboarding course for the Zcash Swift wallet SDK: the Swift orchestration layer, the Rust libzcashlc core, and the FFI boundary between them.'
---

# ZcashLightClientKit onboarding

`ZcashLightClientKit` is an iOS / macOS Swift Package that implements a Zcash
light-wallet client. A thin Swift layer wraps a Rust core (`libzcashlc`,
under [`rust/`](https://github.com/zcash/zcash-swift-wallet-sdk/tree/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust))
through a generated C header. This course is built so that a reader can start
writing pull requests against the SDK within days, not weeks.

:::warning Auto-generated, not authoritative

This site is automatically generated using Claude Code. Errors may have been
introduced. **This site is not authoritative documentation or explanation of
the Zcash protocol.** The only authoritative material is what is published by
the Zcash-related organisations that maintain the protocol and its reference
implementations, in particular:

- the [Zcash Protocol Specification (PDF)](https://zips.z.cash/protocol/protocol.pdf);
- the [Zcash Improvement Proposals (ZIPs)](https://zips.z.cash/);
- the [`librustzcash`](https://github.com/zcash/librustzcash) workspace (the
  Rust crates this SDK depends on);
- the upstream
  [`zcash/zcash-swift-wallet-sdk`](https://github.com/zcash/zcash-swift-wallet-sdk)
  repository itself.

The code is the law. When this course and the source disagree, the source is
right. Corrections are welcome as issues or pull requests against the
`onboarding` branch of the
[fork](https://github.com/dannywillems/zcash-swift-wallet-sdk/tree/onboarding).

:::

## How this course is pinned

Every source embed in this course points at the upstream repository at commit
`fe836893bc71fc3e6eb173f4fc191aa43c3760af` (the `main` tip the course was
generated against). Line numbers and links are stable against that commit even
after upstream refactors. When a chapter discusses a protocol-level
construction it also cites the
[Zcash Protocol Specification](https://zips.z.cash/protocol/protocol.pdf) and
the relevant ZIP, which are the stable mathematical anchors.

## What lives where

This is the single most important fact about the repository: it has two layers
and one bridge.

| Layer  | Language     | Owns                                                                          | Source root                                                                                                                                                           |
| ------ | ------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK    | Swift        | Orchestration, networking, persistence queries, the public API                | [`Sources/ZcashLightClientKit/`](https://github.com/zcash/zcash-swift-wallet-sdk/tree/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit)           |
| Core   | Rust         | Key derivation, note scanning, transaction construction, the wallet DB schema | [`rust/src/`](https://github.com/zcash/zcash-swift-wallet-sdk/tree/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src)                                                 |
| Bridge | Swift over C | The only callers of the generated `libzcashlc` C header                       | [`Sources/ZcashLightClientKit/Rust/`](https://github.com/zcash/zcash-swift-wallet-sdk/tree/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust) |

The cryptography itself (the Orchard and Sapling circuits, Pallas / Jubjub
curves, Sinsemilla, Pedersen hashing, Groth16, Halo 2) does not live in this
repository. It lives in the upstream Rust crates that `libzcashlc` depends on:
[`orchard`](https://github.com/zcash/orchard),
[`sapling-crypto`](https://github.com/zcash/sapling-crypto), and the
[`librustzcash`](https://github.com/zcash/librustzcash) workspace
(`zcash_client_backend`, `zcash_client_sqlite`, `zcash_primitives`, ...). This
SDK consumes those crates; it does not reimplement them. Chapters that touch a
cryptographic object state the type and cite the spec, then point at the
crate where the construction is defined.

## Notation and vocabulary

This course is light on mathematics because the SDK is an orchestration layer.
Where a domain object has a fixed name in the Zcash protocol, this course uses
that name consistently:

- **note**: a shielded value commitment owned by the wallet (Sapling or
  Orchard). Spec Section 3.2.
- **nullifier**: the value revealed when a note is spent, preventing
  double-spends. Spec Section 3.2.
- **anchor**: a note-commitment-tree root a transaction proves membership
  against. Not "Merkle root" once introduced.
- **commitment tree** / **subtree roots**: the incremental Merkle tree of note
  commitments and its checkpointed subtree roots streamed from `lightwalletd`.
- **compact block**: a bandwidth-reduced block containing only the fields a
  light wallet needs to trial-decrypt. Defined by the `lightwalletd` protocol.
- **PCZT**: Partially Created Zcash Transaction, the multi-step transaction
  format (proposal then proof then signature then extraction). ZIP 386 (draft)
  and the [`pczt`](https://github.com/zcash/librustzcash/tree/main/pczt) crate.
- **deshield**: the verb for moving funds from a shielded pool to transparent.
  "unshielded" is only the adjective for transparent-state balances.
- **spend before sync**: the non-linear scan strategy where the wallet scans
  suggested ranges out of order so spendable notes are discovered early.
- **birthday**: the block height at which a wallet was created; scanning starts
  there, seeded from a bundled checkpoint.
- $\mathsf{Zatoshi}$: the smallest unit of ZEC, $1\,\text{ZEC} = 10^{8}$
  zatoshi, modelled by the `Zatoshi` type (`Int64`).

## Threat model and where defences live

The SDK is a light client: it does not hold consensus, and it trusts the
cryptography of the upstream crates. The table below lists the adversary
capabilities the SDK code itself takes responsibility for, the defence in this
workspace, and the test that catches a regression. Cryptographic soundness
(circuit knowledge soundness, commitment binding) is out of scope for this
repository and is defended by the upstream crates and their audits.

| Adversary capability                                                          | SDK-level goal                                  | Defence in this workspace                                                                                        | Regression test                                   |
| ----------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Malicious / buggy `lightwalletd` serves a wrong-network or wrong-branch chain | Refuse to sync against the wrong chain          | `ValidateServerAction` checks the consensus branch ID and network                                                | `OfflineTests` action coverage; see Chapter 07    |
| Chain reorg below the wallet's scanned tip                                    | Recover without losing or double-counting notes | Reorg detection triggers `RewindAction` and a rust-side rewind/truncate                                          | `DarksideTests` reorg scenarios; see Chapter 09   |
| A single submission endpoint drops or censors a transaction                   | Get the transaction mined anyway                | `MultiEndpointSubmitter` races multiple endpoints; `SubmitPlanStore` persists and `TxResubmissionAction` retries | `OfflineTests` submission doubles; see Chapter 14 |
| A network observer correlates wallet traffic                                  | Reduce metadata leakage                         | Optional Tor transport with per-request circuit isolation                                                        | manual / `NetworkTests`; see Chapter 12           |
| Secret key material lingers in process memory                                 | Limit exposure window                           | Spending keys are held in Rust `Secret<_>` and zeroized; Swift passes bytes through the single FFI file          | audit only; see Chapter 04                        |
| A panic in Rust crosses the FFI boundary                                      | Never unwind across `extern "C"`                | Every FFI entry point is wrapped in `catch_panic`                                                                | audit only; see Chapter 03                        |

Each row links to the chapter that walks the defence in code. Where a row says
"audit only", there is no automated test in this workspace and the property is
maintained by review.

## Reading order

The chapters are numbered in dependency order. Read Chapters 01 and 02 first;
return to Chapter 01 (the module map) and the reference pages (cheat-sheet, PR
checklist, glossary) often. The remaining chapters can be read in order or
jumped into by subsystem.
