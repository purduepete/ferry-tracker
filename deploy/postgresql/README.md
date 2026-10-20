# PostgreSQL storage and cutover

Production uses its own `ferry_tracker` database on `jimbrownhome1`. Set
`STORAGE_BACKEND=postgresql` explicitly and place `DATABASE_URL` in private
`app.env`. Do not put connection credentials in process arguments, source files,
reports, or release archives. Missing credentials, connection errors, or a schema
version other than 1 prevent startup. The default backend remains SQLite for the
unmigrated source host. Unknown backend names are rejected.

Source environment files are archival only:
`.env.local` becomes `secrets\source\app.env` and `.env` becomes
`secrets\source\fallback.env`. Runtime `secrets\app.env` is reserved for a separate
operator-prepared target file. Before activation, use a secure terminal outside
VS Code to prepare it from the reviewed frozen export, retain required source
service keys, and add the target database URL. Do not include keys declared in
the manifest's `launch.environment`; the framework supplies them. Do not
automatically merge credentials or load the archived fallback file. Restrict
the runtime file to its service account and administrators. The reviewed
activation checks must verify runtime-account readability, database identity,
schema compatibility and readiness before enabling routes.

## Schema review

Remote URLs must name `jimbrownhome1` and include `hostaddr=<approved-private-IPv4>`,
`sslmode=verify-full`, `sslrootcert=<URL-encoded absolute local Windows CA path>`,
and `gssencmode=disable`. The Node driver helper explicitly connects to the pinned
IP with TLS `servername=jimbrownhome1`, CA verification and
`rejectUnauthorized=true`. It rejects extra/duplicate query parameters and other
remote hosts or noncanonical addresses outside RFC1918 and 100.64/10. Framework
activation verifies that the private pin exactly matches its approved registry
address. Node pg does not implement GSS encryption; the required
`gssencmode=disable` is validated and then omitted from driver configuration.
Query-free loopback URLs retain existing behavior. Build the server before
running the import CLI, which shares this helper.

`001_initial.sql` is an explicit migration artifact. It contains 10 source-data
tables, the 6 existing views, `public.solutiondeploy_schema`, and
`public.solutiondeploy_import` provenance. Source ISO timestamps remain text,
flags remain 0/1 integers, and floating values use double precision. Generated
IDs use bigint identities; source reference IDs remain explicitly supplied.
`archive_file.byte_size` is bigint. The adapter rejects unsafe numeric IDs rather
than silently losing precision.

The two `v_sailing_fill` percentage expressions cast `100.0` to double precision
before multiplication and division, preserving SQLite REAL arithmetic. Casting
the final NUMERIC result is insufficient: PostgreSQL decimal division can round
before conversion to a JavaScript number. For example, `600 / 197` must produce
`3.045685279187817`, rather than `3.0456852791878175`. The generator retains these
casts. Existing installations with NUMERIC percentage columns require an explicit
reviewed view replacement and restoration of all existing grants; startup never
repairs views. Durable tables and the runtime schema-version contract stay at 1.

`generate-schema.mjs` generates the review SQL from the existing schema/views;
it never connects to a database. Regeneration changes the artifact hash and
requires another review. Startup reads only
`SELECT version FROM public.solutiondeploy_schema WHERE app_id=$1`
with `ferry-tracker`; it never applies DDL. The framework verifies the reviewed
SQL SHA-256 separately.

The framework owns provisioning, runtime/migration identities, database isolation,
grants, `pg_dump` custom backups, restore proof, and schema compatibility gates.
Grant runtime DML on application tables and sequence usage. The schema ledger and
import provenance should be runtime SELECT-only. The runtime must not own tables
or have CREATE privileges.

## Import procedure, pending independent review and production approval

1. Fence the source and target application writers. Disable all 3 old Ferry tasks.
2. Create a coherent, reviewed source SQLite backup with no WAL/SHM sidecars. Keep
   the source untouched. Preserve its exact `transfer.json` target path below
   `<snapshot>` (`data\ferry-capture.db` or `backups\source\ferry-capture.db`).
3. Copy the raw gzip archive into the protected destination archive directory.
   Preserve the original source snapshot, backups, environment files, and export
   index under protected backup storage. Never treat the old DB as active target
   storage.
4. Independently review the exact SQL and import script before any database
   operation. Provision the isolated database/roles through the framework, then
   apply `001_initial.sql` explicitly with the migration identity. It intentionally
   fails against existing tables instead of adopting or replacing them.
5. Set `DATABASE_URL` and `CAPTURE_ARCHIVE_DIR` through the protected operator
   environment. The latter must be the final raw-archive directory, not a release
   or staging directory. From the release root, the reviewed invocation is:

    ```powershell
    node deploy\postgresql\import.mjs `
      --source-dir C:\Protected\snapshot `
      --expected-source-sha256 <reviewed-sqlite-file-sha256> `
      --source-index C:\Protected\snapshot\transfer.json `
      --expected-index-sha256 <reviewed-index-sha256> `
      --execute
    ```

    Both index arguments and the SQLite file SHA are mandatory. The script verifies
    the exact proof bytes, source host, plan/declaration hashes, operation/fence
    metadata, and the matching `files` entry's target, kind, byte count and SHA.
    The approved proof hash binds this export to the reviewed plan and application.
    The script does not load dotenv or start the app.
    `DATABASE_URL` must use the dedicated `sd_ferry_tracker_migrator` login.
    Inside its transaction the importer verifies the database/login naming
    convention, executes `SET LOCAL ROLE "sd_ferry_tracker_owner"`, and checks
    the active role before reading or changing application tables. Administrator
    and runtime logins are rejected. Runtime permissions remain unchanged.

6. Import rejects nonempty tables and mismatched hashes. After verifying the
   frozen source, it copies the SQLite bytes into a unique repository
   `.run\ferry-import-*` directory and checks the copy hash before opening it
   read-only. SQLite may create WAL/SHM files even for a read-only WAL database;
   these stay in that private working directory, which is removed after closing.
   The reviewed export is never opened by SQLite or altered.
   It writes bounded 500-row PostgreSQL batches in one
   transaction, and prints elapsed progress every 10,000 rows. It preserves IDs,
   resets identity sequence positions, and compares exact per-table counts and
   ordered row digests. Existing absolute archive paths are changed only to the
   destination archive directory, and every referenced file must exist.
7. Failure rolls back imported rows. Preserve failure output and keep the target
   fenced; there is no overwrite or automatic resume. PostgreSQL sequences are
   not transactional, so any retry needs an explicit review even after rollback.
8. Before activation, separately validate all 6 view results, representative API
   results/aggregates/time ranges, watermark, raw-file hashes, owner/runtime
   privileges, and custom backup restore. The import's row parity does not replace
   these checks. No real database integration was run during implementation.

After target writes begin, PostgreSQL is authoritative. Roll back compatible code
against that database. Never resume the stale source SQLite file automatically.

## Later managed-host moves

`managedState` copies only `data\raw` to `data\raw`, relative to the managed
source and destination shared roots. These raw archives remain required durable
filesystem state. Structured state moves through the framework's PostgreSQL
backup/restore path; a managed move never reruns the legacy SQLite importer or
uses the legacy `state` inventory. Provision runtime `app.env` separately on the
destination with its target database credentials. It is never transferred.

## Runtime and tooling

Capture writers, archive metadata, reference/schedule reconciliation, rollup,
retention, history/crossing cache, and report queries all await database operations.
Transactions pin one PostgreSQL client and commit only after callbacks complete.
Shutdown drains capture and HTTP work before ending the pool.

`capture:report` uses the selected backend and labels PostgreSQL without printing
its connection URL. Raw gzip files and generated reports remain on disk.
`backup-db.mjs`, `watchdog.mjs`, `rebuild-legs.mjs`, and
`backtest-crossings.mjs` reject PostgreSQL mode before opening SQLite. The source
SQLite versions remain available until cutover; target backup/readiness is owned
by the framework. PostgreSQL maintenance repairs require separately reviewed
procedures.

## Opt-in disposable integration test

After independent review of `001_initial.sql` and
`server\test\postgres.integration.ts`, the parent runner can create a fresh empty
`sd_test_ferry` database in its disposable PostgreSQL 18 container. Set only
`SOLUTIONDEPLOY_PG_TEST_URL` to that loopback connection through the private
environment, then run `npm run test:postgres` from the repository root.
The suite never reads `DATABASE_URL`, rejects other database names/hosts and URL
query overrides, verifies the actual database name and empty public schema, then
applies the reviewed migration. It tests transactions/rollback, capture
deduplication, schedule/history/report reads, rollup and the 6 views.
It drops nothing. A second run requires a newly prepared empty test database.
Do not run this command against the application database.

`npm run test:postgres:import` is a separate, independently reviewed action against
a newly empty `sd_test_ferry` database. It creates synthetic SQLite state only
under the repository's unique `.run\pg-import-*` directory, writes a matching
`transfer.json`, and invokes the actual import CLI. It verifies proof/source hash
rejection before writes, source IDs/reference rows/migration history, sequence
continuation and replay refusal. The importer checks all table counts/digests.
It compares the complete frozen-export file/directory inventory and hashes after
both the first import and rejected replay. The test removes only its own fixture
directory and drops no database objects.
Do not run it after the adapter suite without recreating the disposable database.
