---
sidebar_position: 4
title: The Swift Bridge to libzcashlc
description: 'How Sources/ZcashLightClientKit/Rust wraps the C ABI: the two welding protocols, Data-to-pointer marshalling, and turning sentinel returns into ZcashError.'
---

# The Swift Bridge to libzcashlc

## 1. Why this chapter exists

The previous chapter showed the Rust side of the C ABI. This chapter is the
Swift side: the four files under `Sources/ZcashLightClientKit/Rust/` that import
`libzcashlc` and call the `zcashlc_*` functions. It answers: which Swift type
owns DB-bound calls, which owns stateless key derivation, how a Swift `[UInt8]`
or `Data` becomes a `(pointer, length)` pair the C function can read, and how a
sentinel return (`null`, `false`, `-1`) becomes a thrown `ZcashError`. If you add
a wallet capability, you will add a method here, and getting the marshalling or
the error read wrong is how you corrupt memory or report the wrong error. By the
end you can read `ZcashRustBackend.createAccount` and explain every line of its
FFI call.

## 2. Definitions

**Definition 2.1 (the DB-bound surface).** `ZcashRustBackend`
([Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift L69](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift#L69))
conforms to `ZcashRustBackendWelding`
([ZcashRustBackendWelding.swift](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift)).
It holds the database paths as pre-encoded `(String, UInt)` pairs
(`dbData`, `fsBlockDbRoot`, `spendParamsPath`, `outputParamsPath`) and exposes
every FFI call that touches the wallet `dataDb` or the filesystem block cache.
Its methods are `async` and annotated `@DBActor`, serialising DB access.

**Definition 2.2 (the stateless key-derivation surface).**
`ZcashKeyDerivationBackend`
([ZcashKeyDerivationBackend.swift L11](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashKeyDerivationBackend.swift#L11))
conforms to `ZcashKeyDerivationBackendWelding`
([ZcashKeyDerivationBackendWelding.swift L10](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashKeyDerivationBackendWelding.swift#L10)).
It holds only a `networkType` and calls FFI functions that derive or validate
keys and addresses from raw bytes. It opens no database, so its methods are
synchronous and not actor-bound.

**Invariant 2.3 (single point of FFI contact, with two documented exceptions).**
The contract states that the files under `Rust/` are the only callers of the
`libzcashlc` C header. In this commit that holds for the DB and key-derivation
surfaces, but `grep -rn "zcashlc_" Sources/ | grep -v "/Rust/"` shows two other
callers: `Sources/ZcashLightClientKit/Tor/TorClient.swift` (the Tor runtime FFI,
26 call sites) and `Sources/ZcashLightClientKit/Account/AccountMetadataKey.swift`.
Treat the Rust directory as the canonical bridge; the Tor client is covered in
its own chapter and `AccountMetadataKey` is a small key-handling exception.

## 3. The code

### A welding protocol method declaration

The protocol is the contract the rest of the SDK programs against. A
representative DB-bound declaration:

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackendWelding.swift#L81-L87
```

`createAccount` is declared `async throws` and returns a Swift `UnifiedSpendingKey`.
Nothing in the protocol mentions C pointers; the marshalling is the
implementation's job.

### The implementation: marshalling and the error read

The `ZcashRustBackend` implementation of `createAccount` shows the standard
pattern: convert Swift values to C inputs, call the FFI function, check the
return for the sentinel, schedule the free, and map the result back.

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift#L223-L264
```

Reading it line by line:

- `treeState.serializedData(...).bytes` and `[CChar](name.utf8CString)` turn
  Swift values into byte arrays. A Swift `[UInt8]` or `[CChar]` is passed
  directly where C expects `const uint8_t *` / `const char *`; the compiler
  bridges the array to a pointer valid for the duration of the call. The length
  is passed separately as `UInt(seed.count)`, matching the `(ptr, len)` contract
  from the previous chapter.
- `zcashlc_create_account(...)` returns `*mut FFIBinaryKey` (a pointer).
- `guard let ffiBinaryKeyPtr else { throw ZcashError.rustCreateAccount(...) }`
  implements Invariant 2.3 of the previous chapter from the Swift side: a null
  return is the sentinel, so the code reads the thread-local error message and
  throws.
- `defer { zcashlc_free_binary_key(ffiBinaryKeyPtr) }` schedules the matching
  free (Rule 2.4 of the previous chapter) so the Rust-owned allocation is
  reclaimed when the function returns, even on a later throw.
- `ffiBinaryKeyPtr.pointee.unsafeToUnifiedSpendingKey(...)` copies the bytes out
  into an owned Swift type before the `defer` frees the pointer.

A second marshalling idiom appears when the bytes must stay alive only across the
call. `createPCZTFromProposal` uses `withUnsafeBufferPointer`, which guarantees
the buffer is valid inside the closure:

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift#L343-L365
```

The FFI call happens inside the closure and `proposalPtr.baseAddress` is only
valid there; the returned pointer is captured and the sentinel check / free
happen after.

### The integer-sentinel variant: `initDataDb`

Not all functions return pointers. `zcashlc_init_data_database` returns the four
integer codes from the previous chapter, and the Swift wrapper maps each to a
`DbInitResult` case or a throw.

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift#L614-L627
```

`0 -> .success`, `1 -> .seedRequired`, `2 -> .seedNotRelevant`, and the `default`
branch (which catches `-1`) reads the error message and throws
`ZcashError.rustInitDataDb`. This is the Swift mirror of the Rust branch table.

### Reading the error: `lastErrorMessage`

Every sentinel branch above calls `lastErrorMessage(fallback:)`. This free
function is the Swift realisation of the thread-local error channel.

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift#L1315-L1332
```

It calls `zcashlc_last_error_length`; if positive, it allocates a buffer of that
size, calls `zcashlc_error_message_utf8` to fill it, and decodes UTF-8. The
`defer { zcashlc_clear_last_error() }` ensures the thread-local is cleared even
if decoding fails (closing the stale-error failure mode from the previous
chapter). If the length is zero or the bytes are not UTF-8, it returns the
caller's `fallback` string.

### A key-derivation method: `deriveUnifiedSpendingKey`

The stateless surface uses the same marshalling but no actor and no DB path. Its
protocol declaration:

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashKeyDerivationBackendWelding.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashKeyDerivationBackendWelding.swift#L58-L58
```

Its implementation derives a spending key from seed bytes:

```swift reference title="Sources/ZcashLightClientKit/Rust/ZcashKeyDerivationBackend.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashKeyDerivationBackend.swift#L122-L144
```

The pattern matches `createAccount`: `seed.withUnsafeBufferPointer` provides the
`(baseAddress, count)` pair, `zcashlc_derive_spending_key` returns a boxed slice
pointer, `defer { zcashlc_free_boxed_slice(...) }` frees it, and a `nil` pointer
becomes `ZcashError.rustDeriveUnifiedSpendingKey` with the message read by the
static `ZcashKeyDerivationBackend.lastErrorMessage`.

## 4. Failure modes

- Building a byte array, taking a pointer to it, and using that pointer after the
  array has been deallocated (for example storing `withUnsafeBufferPointer`'s
  `baseAddress` and using it after the closure returns). The pointer dangles and
  the read is undefined behaviour. No automated test in this workspace; caught by
  audit only.
- Forgetting the `defer { zcashlc_*_free(ptr) }` after a successful pointer
  return, leaking the Rust allocation; or calling the wrong free for the returned
  type. No automated test in this workspace; caught by audit only.
- Throwing the wrong `ZcashError` case for a sentinel, so the caller misclassifies
  the failure. Caught by:
  `Tests/OfflineTests/ZcashRustBackendTests.swift` `testInitWithShortSeedAndFail`,
  which drives `initDataDb` then a failing `createAccount` and asserts the
  failure path is taken (the test fails if `createAccount` does not throw).
- A key-derivation regression that returns the wrong bytes. Caught by:
  `Tests/OfflineTests/DerivationToolTests/DerivationToolMainnetTests.swift`
  `testDeriveViewingKeysFromSeed`, which derives a spending key then a viewing
  key from a fixed seed and asserts equality with a known vector.

## 5. Spec pointers

- ZIP 32 (https://zips.z.cash/zip-0032): defines the hierarchical key derivation
  that `deriveUnifiedSpendingKey` and `createAccount` implement; the
  `Zip32AccountIndex` parameter is the ZIP-32 account index.
- librustzcash `zcash_keys` (https://github.com/zcash/librustzcash): the Rust
  `UnifiedSpendingKey` / `UnifiedFullViewingKey` types behind the FFI come from
  this crate in the workspace; the Swift types here are thin owned mirrors.
- [The Rust core and the FFI surface](./03-rust-core-ffi-surface.md): the other
  half of every call here; read it for the sentinel and ownership rules this
  chapter consumes.
- [The error model](./17-error-model.md): `ZcashError` is a generated enum; this
  chapter only throws its `rust*` cases.

## 6. Exercises

1. In `lastErrorMessage`, find the line that guarantees the thread-local error
   is cleared regardless of how the function exits, and give its line.
2. Compare how `createAccount` passes `seed` to C with how
   `deriveUnifiedSpendingKey` passes it. One passes the array directly, the other
   wraps it in `withUnsafeBufferPointer`. State which is which by line range.
3. (Reading a test.) Open
   `Tests/OfflineTests/DerivationToolTests/DerivationToolMainnetTests.swift` and
   read `testDeriveViewingKeysFromSeed`. State exactly what it asserts and which
   two welding methods it exercises.

### Answers in the code

1. `defer { zcashlc_clear_last_error() }` at
   [ZcashRustBackend.swift L1317](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift#L1317).
2. `createAccount` passes `seed` directly as the C argument at
   [ZcashRustBackend.swift L247](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashRustBackend.swift#L247);
   `deriveUnifiedSpendingKey` wraps it in `withUnsafeBufferPointer` at
   [ZcashKeyDerivationBackend.swift L126-L133](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Rust/ZcashKeyDerivationBackend.swift#L126-L133).
3. `testDeriveViewingKeysFromSeed`
   ([DerivationToolMainnetTests.swift L51-L58](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Tests/OfflineTests/DerivationToolTests/DerivationToolMainnetTests.swift#L51-L58))
   derives a `UnifiedSpendingKey` with `deriveUnifiedSpendingKey`, derives a
   `UnifiedFullViewingKey` from it with `deriveUnifiedFullViewingKey`, and asserts
   `XCTAssertEqual(expectedViewingKey, viewingKey)` against a fixed expected key.

## 7. Further reading

- Apple's "Calling Functions With Pointer Parameters"
  (https://developer.apple.com/documentation/swift/calling-functions-with-pointer-parameters)
  documents the array-to-pointer bridging and `withUnsafeBufferPointer` lifetime
  rules this chapter relies on.
