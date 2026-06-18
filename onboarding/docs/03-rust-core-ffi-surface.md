---
sidebar_position: 3
title: The Rust Core and the FFI Surface
description: 'How the libzcashlc crate exposes its functionality across the C ABI: naming, panic safety, the thread-local error channel, and memory ownership.'
---

# The Rust Core and the FFI Surface

## 1. Why this chapter exists

The wallet's key derivation, note scanning, transaction construction, and DB
schema all live in the Rust crate `libzcashlc` (`rust/src/`). Swift cannot call
Rust directly; it calls a C ABI that the crate exports. This chapter answers:
what does a single `zcashlc_*` function look like end to end, how does it avoid
crashing the process, how does an error message reach the caller, and who frees
the memory it returns. If you change one of these functions without
understanding the four invariants below, you can corrupt memory or silently
swallow errors that the Swift layer then misreports. By the end you will be able
to read `zcashlc_init_data_database` in `rust/src/lib.rs` and explain each of its
four return values.

## 2. Definitions

**Definition 2.1 (FFI function).** A Rust function exported across the C ABI.
Every such function in this crate is named with the `zcashlc_` prefix and
declared `#[unsafe(no_mangle)] pub extern "C"` (the `no_mangle` keeps the symbol
name; `extern "C"` gives it the C calling convention). The module attribute
`#![deny(unsafe_op_in_unsafe_fn)]` at the top of `lib.rs`
([rust/src/lib.rs L1](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs#L1))
forces every unsafe operation inside an `unsafe fn` to be wrapped in its own
`unsafe` block.

**Invariant 2.2 (no unwinding across the boundary).** A Rust panic must never
cross an `extern "C"` boundary; doing so is undefined behaviour. Every
`zcashlc_*` body is therefore wrapped in `catch_panic(...)` from the
`ffi_helpers` crate, which catches a panic and turns it into `Err(())`. The
result is then converted to a sentinel by `unwrap_exc_or` or
`unwrap_exc_or_null`.

**Invariant 2.3 (errors travel through a thread-local).** An FFI function
returns only a sentinel value (`false`, `-1`, or a null pointer) on failure. The
human-readable error message is stored in a thread-local inside `ffi_helpers`
and is read back by the caller through `zcashlc_last_error_length` followed by
`zcashlc_error_message_utf8`. The caller is responsible for calling
`zcashlc_clear_last_error` afterwards.

**Rule 2.4 (caller-frees memory ownership).** When an FFI function returns a
heap pointer, ownership passes to the caller. Rust hands out the pointer with
`Box::into_raw` (for structs) or `CString::into_raw` (for strings), and the
caller must return it later to the matching `zcashlc_*_free` function so Rust can
reclaim it with `Box::from_raw` / `CString::from_raw`. There is no garbage
collector across the boundary.

## 3. The code

### Panic-safety helpers

`unwrap_exc_or` and `unwrap_exc_or_null` are the two converters that turn the
`Result<T, ()>` returned by `catch_panic` into a sentinel. They sit near the top
of `lib.rs`.

```rust reference title="rust/src/lib.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs#L101-L116
```

`unwrap_exc_or(res, def)` returns the default `def` (typically `-1` or `false`)
if the body errored or panicked. `unwrap_exc_or_null(res)` returns the type's
NULL value (via the `ffi_helpers::Nullable` trait) for functions that return a
pointer. This enforces Invariant 2.2: a panic becomes a sentinel, never an
unwind.

### The error channel

Three functions implement Invariant 2.3. They forward directly to
`ffi_helpers::error_handling`.

```rust reference title="rust/src/lib.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs#L239-L262
```

- `zcashlc_last_error_length` returns the byte length (including the trailing
  NUL) of the last error, or `0` if there is none. The caller uses this to size
  a buffer.
- `zcashlc_error_message_utf8(buf, length)` copies the message into the
  caller-allocated `buf` of `length` bytes. It is `unsafe` because it writes
  through a raw pointer.
- `zcashlc_clear_last_error` discards the stored message.

`catch_panic` is what populates this thread-local: when a body returns `Err(e)`,
`ffi_helpers` records `e` so the next `zcashlc_last_error_length` call sees it.

### A DB-bound function end to end: `zcashlc_init_data_database`

This function sets up the schema of the wallet data database. Its doc comment
states the contract; the body implements four branches.

```rust reference title="rust/src/lib.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs#L288-L330
```

The body is wrapped in `catch_panic(|| { ... })` and the result is fed to
`unwrap_exc_or(res, -1)`. The four return values, each with its precondition:

- `Ok(0)` (success): `init_wallet_db(&mut db_data, seed)` returned `Ok(_)`. The
  schema migrations all ran. Precondition: the path bytes parsed, the network id
  parsed, and no migration required a seed that was missing or wrong.
- `Ok(1)` (seed required): `init_wallet_db` returned an error whose source
  downcasts to `WalletMigrationError::SeedRequired`. Precondition: a pending
  migration needs the seed but `seed` was passed as a null pointer.
- `Ok(2)` (seed not relevant): the error source downcasts to
  `WalletMigrationError::SeedNotRelevant`. Precondition: a seed was supplied but
  it does not derive any account already in the wallet.
- `-1` (error): the catch-all `Err(e) => Err(anyhow!(...))` branch, or a failure
  earlier (path parse, network parse, panic). The `anyhow` error is what later
  surfaces through the thread-local error channel.

Note the seed handling: `seed.is_null()` selects `None`, otherwise the bytes are
read with `slice::from_raw_parts` and wrapped in `secrecy::Secret` so they are
zeroized on drop.

### A stateless function: `zcashlc_seed_fingerprint`

Not every FFI function opens the database. `zcashlc_seed_fingerprint` computes a
ZIP-32 seed fingerprint from raw seed bytes and writes 32 bytes into a
caller-provided output buffer. It returns `bool`.

```rust reference title="rust/src/lib.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs#L1260-L1295
```

Branches:

- returns `Err(...)` (so the sentinel `false`) if `seed_len` is outside
  `32..=252`, or if `SeedFingerprint::from_seed` returns `None`.
- returns `Ok(true)` after copying the 32-byte fingerprint into
  `signature_bytes_ret` with `copy_from`. The output buffer is caller-owned, so
  there is nothing for the caller to free here. Contrast this with the next two
  functions, which return Rust-owned memory.

### Freeing a string: `zcashlc_string_free`

Functions that return a `*mut c_char` (for example an encoded address) created
the string with `CString::into_raw`. The caller must return it here.

```rust reference title="rust/src/lib.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs#L2333-L2345
```

`CString::from_raw` reconstructs the owning `CString` so its `Drop` frees the
allocation. The null check makes it safe to call on a sentinel return. This is
the concrete realisation of Rule 2.4 for strings.

### A `#[repr(C)]` struct and its free: `Account` in `ffi.rs`

FFI types that cross the boundary live in `rust/src/ffi.rs` and are `#[repr(C)]`
so their layout matches the C header. `Account` carries four owned C strings plus
inline byte arrays.

```rust reference title="rust/src/ffi.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/ffi.rs#L23-L43
```

The `NOT_FOUND` associated constant (L35-L43) is the sentinel a lookup returns
instead of a null pointer when the account id is unknown: all-zero uuid, null
string pointers, and `hd_account_index = u32::MAX`.

The matching free walks every owned pointer inside the struct before dropping the
box itself:

```rust reference title="rust/src/ffi.rs"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/ffi.rs#L72-L95
```

`zcashlc_free_account` takes the pointer back with `Box::from_raw`, then frees
each non-null `*mut c_char` field by calling `zcashlc_string_free` on it, then
drops the box. Freeing only the box without freeing the four strings would leak
the strings; this is the nested-ownership case of Rule 2.4.

(The naming: in the generated C header these become `FfiAccount`, `FfiUuid`, and
so on. The rename happens in `build.rs`; see
[the FFI build pipeline](./05-ffi-build-pipeline.md).)

## 4. Failure modes

- Forgetting to wrap a new function body in `catch_panic`. A panic (for example
  an `.unwrap()` on a bad `CString`) would unwind across `extern "C"`, which is
  undefined behaviour. No automated test in this workspace; caught by audit
  only.
- Returning a Rust-owned pointer (via `Box::into_raw` or `CString::into_raw`)
  without adding a matching `zcashlc_*_free`, or not freeing every owned field
  inside a struct (as `zcashlc_free_account` does for its four strings). The
  result is a memory leak. No automated test in this workspace; caught by audit
  only.
- Reading a `(ptr, len)` pair with `slice::from_raw_parts` without first checking
  the pointer for null when null is a legal input (as `zcashlc_init_data_database`
  does for `seed`). Caught by: `Tests/OfflineTests/ZcashRustBackendTests.swift`
  `testInitWithShortSeedAndFail`, which calls `initDataDb(seed: nil)` and expects
  `.success`, exercising the null-seed path.
- Returning a failure sentinel but leaving a stale message in the thread-local
  from an earlier call, or never clearing it. The next caller reads the wrong
  error string. Caught by audit only; the Swift `lastErrorMessage` helper does
  call `zcashlc_clear_last_error` in a `defer` (see
  [the Swift bridge](./04-swift-rust-bridge.md)).

## 5. Spec pointers

- librustzcash (https://github.com/zcash/librustzcash): `libzcashlc` is a thin C
  wrapper over the `zcash_client_backend` and `zcash_client_sqlite` crates from
  this workspace; `init_wallet_db` and the `WalletMigrationError` variants used
  by `zcashlc_init_data_database` come from `zcash_client_sqlite`.
- The `ffi_helpers` crate (https://crates.io/crates/ffi_helpers): provides
  `catch_panic`, the `Nullable` trait, and the thread-local
  `error_handling::last_error_length` / `error_message_utf8` / `clear_last_error`
  that Invariants 2.2 and 2.3 rely on. Pinned at `"0.3"` in `rust/Cargo.toml`.
- The `anyhow` crate (https://crates.io/crates/anyhow): every error branch builds
  an `anyhow::Error` with `anyhow!(...)`; its source chain is what
  `zcashlc_init_data_database` downcasts to detect `SeedRequired` /
  `SeedNotRelevant`.
- The header generation (cbindgen) and the bindgen step that produce the C ABI
  belong to [the FFI build pipeline](./05-ffi-build-pipeline.md). The Swift side
  that consumes these functions is [the Swift bridge](./04-swift-rust-bridge.md).

## 6. Exercises

1. Find the sentinel return value of `zcashlc_seed_fingerprint` on failure, and
   the one branch that produces success. Give the line range that contains the
   final return statement.
2. Trace how the error string "Error while initializing data DB: ..." created in
   `zcashlc_init_data_database` reaches a Swift caller. Name the three FFI
   functions, in order, that the caller invokes to read and clear it.
3. (Reading/modification.) Suppose you add a new FFI function
   `zcashlc_get_wallet_label` that returns a `*mut c_char`. Which existing
   `zcashlc_*` function must the caller use to free its result, and which Rust
   constructor (`Box::into_raw` or `CString::into_raw`) must your function use to
   produce the pointer? State both, and explain why calling the wrong free
   function would be undefined behaviour.

### Answers in the code

1. The body returns `false` via `unwrap_exc_or(res, false)` at
   [rust/src/lib.rs L1294](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs#L1294);
   the success branch is `Ok(true)` at
   [rust/src/lib.rs L1290-L1292](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs#L1290-L1292).
2. The message is recorded by `catch_panic` when the body returns `Err`
   ([rust/src/lib.rs L296-L329](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs#L296-L329)).
   The caller reads it with `zcashlc_last_error_length` then
   `zcashlc_error_message_utf8`, then calls `zcashlc_clear_last_error`
   ([rust/src/lib.rs L239-L262](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs#L239-L262)).
3. The caller frees a `*mut c_char` with `zcashlc_string_free`
   ([rust/src/lib.rs L2333-L2345](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/lib.rs#L2333-L2345)),
   which calls `CString::from_raw`, so the function must produce the pointer with
   `CString::into_raw` (as `Account::from_account` does at
   [rust/src/ffi.rs L52-L67](https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/rust/src/ffi.rs#L52-L67)).
   Mixing allocators (for example freeing a `Box` pointer with `CString::from_raw`)
   is undefined behaviour.

## 7. Further reading

- The Rustonomicon chapter on FFI and unwinding
  (https://doc.rust-lang.org/nomicon/ffi.html) explains why panics must not cross
  `extern "C"`, the reason Invariant 2.2 exists.
- ZIP 32 (https://zips.z.cash/zip-0032) defines the seed fingerprint that
  `zcashlc_seed_fingerprint` computes; see [the Swift bridge](./04-swift-rust-bridge.md)
  for the derivation surface that uses it.
