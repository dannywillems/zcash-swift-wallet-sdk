---
sidebar_position: 10
title: 'Persistence: dataDb, DAO, and Repository'
description: 'How the Swift SDK reads wallet metadata out of the Rust-owned dataDb through DAO and Repository types.'
---

# Persistence: dataDb, DAO, and Repository

## 1. Why this chapter exists

The SDK keeps wallet metadata (accounts, transactions, notes, blocks) in a
SQLite database called `dataDb`. The Rust core owns the schema and performs
every write; the Swift layer only reads. If you do not know that split, you
will be tempted to `INSERT` from Swift, or to hand-roll a query that drifts
from the Rust schema, and the next Rust migration will silently break your
code. By the end of this chapter you will be able to read
`Sources/ZcashLightClientKit/DAO/TransactionDao.swift` and explain which SQL
view each `find(...)` method targets and why the DAO is opened read-only.

## 2. Definitions

**Definition 2.1 (dataDb).** The SQLite database holding wallet metadata:
accounts, transactions, sent and received notes, and a `blocks` table. Its
schema and all migrations are defined by the Rust core (see
[the FFI surface](./03-rust-core-ffi-surface.md) and
[the Swift-Rust bridge](./04-swift-rust-bridge.md)). The SDK reaches it
through a `dataDbURL` configured in `Initializer.swift`.

**Definition 2.2 (DAO).** A Data Access Object: a concrete type that issues
SQLite queries against `dataDb` and decodes rows into entities. Examples:
`TransactionSQLDAO`, `BlockSQLDAO`, `PagedTransactionDAO`.

**Definition 2.3 (Repository).** A protocol that declares the read operations
the rest of the SDK depends on, decoupled from the concrete DAO. Example:
`TransactionRepository`, implemented by `TransactionSQLDAO`.

**Definition 2.4 (Entity).** A value type decoded from a row, for example
`Block`, `UTXO` (conforming to `UnspentTransactionOutputEntity`), and the
`ZcashTransaction.Overview` and `ZcashTransaction.Output` types.

**Invariant 2.5 (Swift reads, Rust writes).** Swift DAOs over `dataDb` are
read-only. Every connection is opened with `readonly: true` (see
`TransactionRepositoryBuilder` in section 3). All writes to `dataDb` go
through the Rust backend. Do not add an `INSERT`, `UPDATE`, or `DELETE` to a
Swift DAO.

**Rule 2.6 (storage map).** Three on-disk stores must not be confused:
`dataDb` (this chapter) holds wallet metadata; the filesystem block cache
(see [download and filesystem storage](./08-download-and-filesystem-storage.md))
holds downloaded compact blocks on disk, not in SQLite; and `SubmitPlanStore`
(see [multi-server submission](./14-broadcaster-multi-server-submission.md)) is
a separate Swift-owned SQLite database for pending transaction submissions.
`SubmitPlanStore` is the one SQLite store the SDK writes to itself; its detail
belongs to chapter 14.

## 3. The code

### The repository protocol

`TransactionRepository` is the read surface. Every method is a query; none
mutate.

```swift reference title="Sources/ZcashLightClientKit/Repository/TransactionRepository.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Repository/TransactionRepository.swift#L10-L31
```

`closeDBConnection`, `countAll`, `find(rawID:)`, `findReceived`, `findSent`,
`findForResubmission`, `findMemos`, `getTransactionOutputs`, and the rest are
all reads. `findForResubmission(upTo:)` is the query that feeds the resubmit
path discussed in [multi-server submission](./14-broadcaster-multi-server-submission.md).

### How the connection is built read-only

`TransactionRepositoryBuilder` is the only place that constructs the concrete
DAO, and it always passes `readonly: true`. This enforces Invariant 2.5 at
the connection level: a stray write would fail at runtime.

```swift reference title="Sources/ZcashLightClientKit/Repository/TransactionRepositoryBuilder.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Repository/TransactionRepositoryBuilder.swift#L10-L18
```

### A DAO implementation and a representative query

`TransactionSQLDAO` is the concrete `TransactionRepository`. It targets two
SQLite views, `v_transactions` and `v_tx_outputs`, declared with the
SQLite.swift dependency (`Package.swift` adds `SQLite` from
[SQLite.swift](https://github.com/stephencelis/SQLite.swift)). The DAO never
names a base table for transactions; it reads the Rust-defined views.

```swift reference title="Sources/ZcashLightClientKit/DAO/TransactionDao.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/DAO/TransactionDao.swift#L36-L59
```

The query style uses SQLite.swift's typed `View`, `Table`, and
`SQLite.Expression<T>` builders rather than raw SQL strings. A representative
query is `fetchTxidsWithMemoContaining`: it joins the two views on `txid`,
filters to rows whose `memo_count > 0`, and applies a `LIKE` over the memo
column.

```swift reference title="Sources/ZcashLightClientKit/DAO/TransactionDao.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/DAO/TransactionDao.swift#L101-L116
```

Each of the three branches of the read API has a distinct precondition:

- `find(offset:limit:kind:)` orders by `minedHeight` descending and paginates
  with `limit(limit, offset: offset)`; the offset is the precondition the
  caller must get right.
- `find(in:limit:kind:)` filters to a closed `CompactBlockRange` of
  `minedHeight`.
- `findForResubmission(upTo:)` filters to unmined sent transactions whose
  `expiryHeight > upTo`.

```swift reference title="Sources/ZcashLightClientKit/DAO/TransactionDao.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/DAO/TransactionDao.swift#L194-L204
```

### The DBActor

Concurrent access to `dataDb` is serialized through a global actor,
`DBActor`. Query methods that touch the connection are annotated `@DBActor`
(see `countAll`, `fetchTxidsWithMemoContaining`, and the private `execute`
overload in `TransactionDao.swift`).

```swift reference title="Sources/ZcashLightClientKit/Utils/DBActor.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Utils/DBActor.swift#L9-L21
```

### An entity and a second DAO

`BlockSQLDAO` reads the `Blocks` table and decodes rows into the `Block`
entity, whose `TableStructure` declares the `height` and `time` columns as
`SQLite.Expression<Int>`.

```swift reference title="Sources/ZcashLightClientKit/DAO/BlockDao.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/DAO/BlockDao.swift#L14-L29
```

The UTXO read surface uses the `UnspentTransactionOutputEntity` protocol,
implemented by the `UTXO` struct.

```swift reference title="Sources/ZcashLightClientKit/Entity/UnspentTransactionOutputEntity.swift"
https://github.com/zcash/zcash-swift-wallet-sdk/blob/fe836893bc71fc3e6eb173f4fc191aa43c3760af/Sources/ZcashLightClientKit/Entity/UnspentTransactionOutputEntity.swift#L10-L18
```

## 4. Failure modes

- Adding a write (`INSERT`/`UPDATE`/`DELETE`) to a Swift DAO over `dataDb`.
  The connection is opened `readonly: true`, so the write fails at runtime,
  and even if it did not, it would bypass the Rust-owned schema and
  migrations. No automated test in this workspace asserts read-only-ness;
  caught by audit only.
- Query drift after a Rust schema migration. A Swift query that names a
  column or view the migration renamed throws at decode/execute time. Caught
  by: `Tests/OfflineTests/TransactionRepositoryTests.swift` exercises
  `countAll` / `countUnmined` against a pre-populated `dataDb`, so a column
  rename that affects the count surfaces there.
- Pagination off-by-one. `find(offset:limit:kind:)` uses
  `limit(limit, offset: offset)`; passing the wrong offset returns the wrong
  page. Caught by: `Tests/OfflineTests/PagedTransactionRepositoryTests.swift`.

## 5. Spec pointers

- [SQLite.swift](https://github.com/stephencelis/SQLite.swift): the typed
  query builder the DAOs use; read its `Table`/`View`/`Expression` docs to
  understand the `filter`/`order`/`limit` chain in `TransactionDao.swift`.
- `MIGRATING.md` in the repo root: documents the move away from a SQLite
  `cacheDb` to filesystem block storage, which is why `dataDb` here holds only
  metadata and not blocks.
- [the Swift-Rust bridge](./04-swift-rust-bridge.md): where the writes to
  `dataDb` actually originate, since Swift only reads.

## 6. Exercises

1. Identify the SQL view and the join key used by the memo-search query.
   Give the file and line range and name the two views.
2. Read `Tests/OfflineTests/TransactionRepositoryTests.swift` and state the
   exact count `testCount` asserts and how the test database is built (which
   helper supplies the pre-populated `dataDb`).
3. (Modify/assert.) In a local checkout, change `testCount` in
   `TransactionRepositoryTests.swift` to assert a deliberately wrong count
   (for example `22`) and confirm the offline test now fails; then restore it
   and confirm it passes. This verifies the test is actually reading `dataDb`.

### Answers in the code

1. `Sources/ZcashLightClientKit/DAO/TransactionDao.swift#L101-L116`. The views
   are `v_transactions` and `v_tx_outputs` (declared at
   `TransactionDao.swift#L51-L52`); the join key is `txid`.
2. `Tests/OfflineTests/TransactionRepositoryTests.swift#L30-L34` asserts the
   count is `21`; the database comes from
   `TestDbBuilder.prePopulatedMainnetDataDbURL()` and the repository from
   `TestDbBuilder.transactionRepository(rustBackend:)`
   (`TransactionRepositoryTests.swift#L15-L23`).
3. The assertion lives at `TransactionRepositoryTests.swift#L33`.

## 7. Further reading

The `ZcashTransaction.Overview` and `ZcashTransaction.Output` row decoders
referenced throughout `TransactionDao.swift` are worth reading to see how a
SQLite row maps to a Swift value, including how `Blob` columns become `Data`.
