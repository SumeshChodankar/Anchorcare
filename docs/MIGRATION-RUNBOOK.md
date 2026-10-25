# Anchorcare — Atlas Cluster Migration Runbook

**Status:** operational runbook, v1 (2026-10-24)
**Scope:** move the `engram` database from the current Atlas cluster to a new Atlas
cluster in a different Atlas organization, and bring the new cognitive schema up on it.
**Verification tool:** [`db/migration-verify.js`](../db/migration-verify.js) — `npm run schema:migrate-verify`
**Related:** [`ATLAS-MEMORY-SCHEMA.md`](./ATLAS-MEMORY-SCHEMA.md) · [`REALTIME-CAPTURE-AND-CLUSTER.md`](./REALTIME-CAPTURE-AND-CLUSTER.md)
**Budget:** §11 revises the cluster sizing in `REALTIME-CAPTURE-AND-CLUSTER.md` §22.2
down for a 100-credit allowance. Read it before your friend creates the cluster.

---

## 0. What this migration actually is

It is **three jobs wearing one name**, and conflating them is the main way this goes
wrong:

| Job | Moves what | Tool |
| --- | --- | --- |
| **1. Move the bytes** | The ~30 collections that exist today: `episodes`, `sources`, `people`, `plans`, `prompts`, `daily_logs`, `mobile_*`, GridFS images | `mongodump` / `mongorestore` |
| **2. Build the new schema** | 46 collection specs, 10 search/vector indexes, 2 views, 4 time-series collections, validators | `db/provision.js` |
| **3. Backfill the new layers** | `semantic_nodes`, `semantic_edges`, `memory_links`, derived episode fields — none of which exist on the source | `db/backfill-semantic.js` |

Job 1 is a migration. Jobs 2 and 3 are a schema upgrade that happens to be running on
a new cluster. **No migration tool does jobs 2 or 3**, which is why the method choice
below matters less than people expect, and why the *ordering* matters more.

### Your situation, as given

| | |
| --- | --- |
| Source cluster | Atlas, **M10+ dedicated**, you have **full admin** |
| Target cluster | New Atlas cluster in your friend's organization; you will have Project Owner or Data Access Admin |
| Downtime tolerance | **Any** — this is a demo cluster |
| Data size | Unknown → §1.1 measures it before anything else |
| Application | Node.js / TypeScript, driver `mongodb ^6.20.0` (root and `engram-retrieval/`) |
| Connection config | `MONGODB_URI` + `MONGODB_DATABASE=engram`, read in `engram-retrieval/src/config.js` |
| Known complication | A second database named `test` holds `alerts`, `conversations`, `memories` — not written by this codebase (§5.13) |

Three of the six questions you listed are answered by the repo itself: the driver is
`mongodb ^6.20.0`, the app is Node/TypeScript, and the connection point is a single
environment variable in two `.env` files. That is the single most important fact for
"no breaking changes in my application code" — **the cutover is two lines of
configuration, not a code change.**

### 0.1 Measure before you plan

```sh
export SOURCE_URI='mongodb+srv://<admin>:<pw>@<old-cluster>.xxxxx.mongodb.net/'

mongosh "$SOURCE_URI" --quiet --eval '
  print("server version : " + db.version());
  print("FCV            : " + JSON.stringify(
    db.adminCommand({getParameter:1, featureCompatibilityVersion:1}).featureCompatibilityVersion ?? "restricted"));
  print("");
  db.adminCommand({listDatabases:1}).databases.forEach(d =>
    print(`db ${d.name.padEnd(14)} ${(d.sizeOnDisk/1048576).toFixed(1)} MB`));
  print("");
  const e = db.getSiblingDB("engram");
  let total = 0;
  e.getCollectionNames().sort().forEach(n => {
    const s = e.getCollection(n).stats();
    total += s.count;
    print(`${n.padEnd(26)} ${String(s.count).padStart(8)} docs  ${(s.size/1048576).toFixed(2).padStart(8)} MB  ${s.nindexes} idx`);
  });
  print(`\ntotal documents: ${total}`);
'
```

Record the output. It is your baseline for "zero data loss", and the per-collection
counts are what `db/migration-verify.js` will check against later.

> If the total is under ~2 GB — which it almost certainly is for a demo cluster — the
> entire dump and restore will take under a minute and everything below is
> comfortable. If it is over 20 GB, come back and re-read §1 before continuing.

---

### 0.2 Your eleven steps, mapped to this runbook

The order you listed is the right one. Here is where each step lives, and the two
places where the order you gave would cause a problem.

| # | Your step | Here | Note |
| --- | --- | --- | --- |
| 1 | Prepare NEW cluster: version pin, project settings, roles, IP allowlist | §B1–B2, §A5–A6, **§11** | §11 revises the tier down: M10 coupled search, not M30 + Search Nodes |
| 2 | Dump from OLD | §D1 | Preceded by §D0 — freeze and *prove* silence |
| 3 | Restore to NEW | §D2 | `--stopOnError`, never `--drop` |
| 4 | Run `provision.js` on NEW | §D4 | **After** the restore, never before (§B3) |
| 5 | Run `backfill-semantic.js` on NEW | §D6 | **Moved after step 6.** Backfill reads episodes that provisioning has just indexed; running it before the indexes exist works but scans |
| 6 | Rebuild all Search + Vector indexes | §D4–D5 | `provision.js` *requests* them; §D5 is the wait. The wait is the step people skip |
| 7 | Configure Automated Embedding, or switch to manual | **§B4 — move this earlier** | Must be decided *before* §D4, because it determines the index definition. Deciding it at step 7 means re-creating indexes under a new name |
| 8 | Run `migration-verify.js` (normal + `--deep`) | §D3 | **Moved before steps 4–7.** Verify the bytes landed before building anything on top of them — otherwise a failed verify means unwinding the schema too |
| 9 | Freeze writes on OLD at cutover | §D0 | **Moved to the very start.** Freezing at cutover means the dump captured a moving target and §12.1 applies |
| 10 | Switch application connection strings | §D7 | Two `.env` files; no code change |
| 11 | Post-migration checks and monitoring | §E1–E7 | Plus §12.4: revoke write access on OLD immediately after |

Three re-orderings, each for a specific reason:

- **Freeze first, not at cutover.** A dump taken while writes continue is a dump of a
  moving target, and the writes that land after it are invisible to verification
  (§12.1). Because downtime is free for you, freezing at the start costs nothing and
  removes the entire class of problem.
- **Verify before provisioning.** If `migration-verify.js` fails, you want to re-run
  a restore into an empty database — not unpick a provisioned schema and a backfill
  first.
- **Decide the embedding mode before creating indexes.** `EMBEDDING_MODE` determines
  whether the vector index is `autoEmbed` on `searchText` or `vector` on `embedding`.
  Deciding after the indexes exist means creating new ones under new names, because
  an existing search index is never edited (§7.2).

---

## 1. Method selection

All three methods are technically available to you: you have full admin on an M10+
source, which is the usual blocker. So this is a choice about trade-offs, not
constraints.

### 1.1 The decision

> **Use `mongodump` / `mongorestore` for the data, then `db/provision.js` for the
> schema, then `db/backfill-semantic.js` for the new layers.**

This is the "hybrid approach" from your brief, and it is the right one — but the
hybrid is not *between migration tools*. It is three tools doing three different
jobs, in a fixed order.

### 1.2 Why not Atlas Live Migration (pull)

Technically possible. Rejected because the price is high and the benefit is zero
in your situation:

| Requirement | Impact on you |
| --- | --- |
| `Project Owner` + `clusterMonitor` on the destination | Fine — your friend grants it |
| Source migration user needs `readAnyDatabase`, `backup`, **and a custom role granting `setUserWriteBlockMode` + `bypassWriteBlockingMode`** | You have admin, so possible, but it is real setup on a cluster you are about to abandon |
| **Destination must be new or empty** (or you tick "clear existing data") | Forces migration *before* provisioning — which is the order we want anyway, so no loss |
| **Writes to the destination are blocked during migration** | You cannot provision or backfill until it completes |
| **Does not migrate Atlas Search indexes** | You rebuild all 10 regardless |
| **Does not migrate users or roles** | You recreate the app user regardless |
| Destination must match or exceed source in RAM/CPU/storage; the docs recommend **M40+**, and at least two tiers above the source | Expensive and absurd for demo data, in your friend's account |
| **"Latest Version With Auto Upgrades" is not supported** | A real trap if your friend creates the cluster with the default version setting |
| Source firewall must allow MongoDB's live-migration IP ranges | More network setup |

Live Migration exists to minimise downtime. **You told me downtime is free.** You
would be paying all of that cost for a benefit worth nothing.

### 1.3 Why not `mongosync`

Also technically possible — both clusters are M10+ — and also rejected, with one
disqualifier that is specific to your schema:

| `mongosync` limitation | Impact on you |
| --- | --- |
| **Does not support time-series collections** | Your new schema has four (`memory_trace_ts`, `symptom_ts`, `physiology_ts`, `engagement_ts`). They do not exist on the source *today*, so a sync would succeed now — but if anyone creates one before cutover, the migration fails. That is a landmine under a demo deadline |
| **Does not sync Atlas Search indexes** | Rebuild all 10 regardless |
| **Does not sync users or roles** | Recreate regardless |
| **Destination must be empty**, and no other client may write to it while syncing | You cannot provision or backfill until the sync is `COMMITTED` |
| Requires `atlasAdmin` on source and `atlasAdmin` + `bypassWriteBlockingMode` on destination | More role setup in your friend's project |
| Requires **"Require Indexes for All Queries" disabled** (`notablescan: false`) on both | A project setting you may not control in your friend's account |
| It is a long-running process with its own state database that you must babysit | For a dataset that `mongodump` finishes in seconds |

`mongosync` is the right tool for a 500 GB production cluster that cannot stop taking
writes. It is the wrong tool for a demo database when you can simply stop writing for
five minutes.

### 1.4 Why `mongodump` / `mongorestore` is right here

1. **You have full admin on the source.** The usual reason people reach for Live
   Migration — insufficient source permissions — does not apply.
2. **Downtime is free**, which removes the only advantage the other two have.
3. **Organization boundaries are irrelevant.** `mongodump` writes a file; `mongorestore`
   reads a file. Neither knows or cares that the clusters are in different Atlas
   organizations. Live Migration's Atlas-to-Atlas flow couples the two accounts;
   this does not.
4. **You keep an artefact.** The archive file *is* your rollback and your backup. A
   live sync leaves you nothing to hold.
5. **You control the ordering precisely**, which matters because jobs 2 and 3 have to
   happen after job 1 and before cutover.
6. **It is restartable.** A failed restore is re-runnable from the same archive. A
   failed Live Migration must restart from the beginning.

### 1.5 The one thing no method gives you

**No migration tool moves Atlas Search or Vector Search indexes.** Not Live
Migration, not `mongosync`, not `mongodump`. All ten of yours —
`episodes_text`, `episodes_auto`, `episodes_visual`, `semantic_text`, `semantic_auto`,
`chapters_text`, `chapters_auto`, `procedures_text`, `conversation_text`,
`conversation_auto` — must be created on the target and allowed to build.

This is the highest-risk item in the whole migration, and §5.1 explains why.

---

## 2. Phase A — Pre-migration

Nothing in Phase A touches the target cluster. All of it is reversible.

### A1. Inventory the source

```sh
# Full inventory: collections, counts, indexes, validators, search indexes
mongosh "$SOURCE_URI" --quiet --eval '
  const db0 = db.getSiblingDB("engram");
  db0.getCollectionInfos().forEach(c => {
    if (c.type === "view") { print(`VIEW ${c.name}`); return; }
    const col = db0.getCollection(c.name);
    print(`\n=== ${c.name}  (${col.countDocuments({})} docs)`);
    if (c.options?.validator) print("    VALIDATOR PRESENT");
    if (c.options?.timeseries) print("    TIME-SERIES: " + JSON.stringify(c.options.timeseries));
    col.getIndexes().forEach(i =>
      print(`    idx ${i.name}  ${JSON.stringify(i.key)}` +
            (i.expireAfterSeconds !== undefined ? `  TTL=${i.expireAfterSeconds}` : "") +
            (i.unique ? "  UNIQUE" : "") +
            (i.partialFilterExpression ? "  PARTIAL" : "")));
  });
' | tee migration-source-inventory.txt
```

```sh
# Search indexes, which the inventory above does not show
mongosh "$SOURCE_URI" --quiet --eval '
  const db0 = db.getSiblingDB("engram");
  ["episodes"].forEach(n => {
    try { db0.getCollection(n).aggregate([{$listSearchIndexes:{}}]).forEach(i =>
      print(`${n}.${i.name}  type=${i.type ?? i.latestDefinition?.type ?? "search"}  status=${i.status}  queryable=${i.queryable}`));
    } catch (e) { print(n + ": " + e.message); }
  });
' | tee migration-source-search-indexes.txt
```

Commit both files. When something looks wrong on the target at 2 a.m., this is what
you diff against.

### A2. Run the live audit on the source

```sh
MONGODB_URI="$SOURCE_URI" npm run schema:audit-live
```

This is the read-only audit from the previous session. On the source it will report
every unindexed collection, every TTL landmine, every unscoped document and the
`test` database. **Fix nothing on the source** — you are about to leave it. Capture
the output so you know what the target must end up *better* than.

### A3. Compatibility checks

```sh
mongosh "$SOURCE_URI" --quiet --eval 'print("source: " + db.version())'
```

| Check | Required | Why |
| --- | --- | --- |
| Source version | any 6.0+ | `mongodump` output restores forward cleanly |
| **Target version** | **8.0 or later** | `$rankFusion` requires 8.0+. Your hybrid retrieval is built on it and verified on 8.0.34 (`docs/LIVE-ATLAS-VERIFICATION.md`). A 7.0 target silently breaks every hybrid recall |
| Target version setting | **a pinned major version, not "Latest Version With Auto Upgrades"** | Auto-upgrade can move you onto a minor release that lacks support for the features you depend on |
| Driver | `mongodb ^6.20.0` — already correct | Driver 6.x supports server 6.0 → 8.x. **No application code change is needed** |
| `featureCompatibilityVersion` | Atlas manages it; do not attempt to set it | On M10+ Atlas, `setFeatureCompatibilityVersion` is restricted. If source FCV < target version, Atlas handles it |
| Tooling | `mongodump`/`mongorestore` ≥ 100.9 | Older Database Tools mishandle some newer BSON and compression options |

```sh
mongodump --version   # expect "mongodump version: 100.x"
```

If the Database Tools are missing: they are a separate download from the server and
from `mongosh` — install the **MongoDB Database Tools** package.

### A4. Backup strategy

You will have **three** independent recovery points. Do not skip any of them.

1. **The source cluster itself**, left running and untouched. This is the real
   rollback (§6).
2. **An Atlas on-demand snapshot of the source**, taken before you start:
   Atlas UI → old cluster → Backup → *Take Snapshot Now*. Costs nothing meaningful,
   and is the only thing that survives someone dropping the source database by mistake.
3. **The dump archive**, stored off the laptop you are working on.

```sh
mkdir -p ~/anchorcare-migration && cd ~/anchorcare-migration
# the archive created in Phase D lands here; copy it somewhere else too
```

> The dump archive contains real-looking patient narrative. Treat it as sensitive:
> do not put it in the repo, do not commit it, do not drop it in a shared Drive
> folder. `.gitignore` already excludes `.env`; it does not exclude `*.archive`.

```sh
printf '\n# migration artefacts\n*.archive\nmigration-*.txt\nmigration-*.log\n' >> .gitignore
```

### A5. Network access

On the **target** project (your friend's account):

| Setting | Value |
| --- | --- |
| IP Access List | Your current public IP (`curl -s ifconfig.me`), plus any deploy host |
| Temporary entry | Add with a 6-hour expiry during the migration rather than permanently |
| `0.0.0.0/0` | **No.** Not even temporarily. It is the single most common way a demo cluster ends up mined |

```sh
curl -s ifconfig.me    # the IP to whitelist
```

The **source** needs no network changes: you are connecting outbound from your
machine, which already works.

### A6. Roles your friend must grant

Ask for these specifically, in this order:

| Where | Role | Needed for |
| --- | --- | --- |
| Atlas project | **Project Owner** (or Project Data Access Admin + Project Cluster Manager) | Creating search indexes, views, the IP list and database users |
| Database user | A new user `anchorcare_app` with **`readWrite` on `engram`** | The application |
| Database user | A migration user with **`readWriteAnyDatabase` + `dbAdminAnyDatabase`** | `mongorestore` needs `dbAdmin` to create collections, indexes and validators |

A single `atlasAdmin` user for the migration is simpler and acceptable for a demo —
but create the narrower `anchorcare_app` user for the application itself, and put
*that* one in `.env`. The migration credential should never end up in application
configuration.

> Atlas does not migrate users or roles by any method. Expect to create these by hand
> whichever tool you use.
---

## 3. Phase B — Target cluster preparation

### B1. Create the cluster, with the right settings

Have your friend create it, or create it yourself once you have Project Owner.

| Setting | Value | If you get this wrong |
| --- | --- | --- |
| Tier | **M10 or higher** | M0/Flex caps the number of search indexes well below the 10 you need, and rules out Online Archive and dedicated Search Nodes |
| MongoDB version | **8.0**, pinned — *not* "Latest Version With Auto Upgrades" | 7.0 silently breaks `$rankFusion`; auto-upgrade can move you onto an unsupported minor release |
| Region | The same region as the one you run the app from | Every retrieval round-trip pays the latency; the §12.8 budget assumes co-location |
| Cluster name | `engram-prod` (or `anchorcare-prod`) | — |
| Backup | Enable Cloud Backup | — |

```sh
# Verify before doing anything else
export TARGET_URI='mongodb+srv://<migration-user>:<pw>@engram-prod.xxxxx.mongodb.net/'
mongosh "$TARGET_URI" --quiet --eval '
  print("target version: " + db.version());
  if (parseInt(db.version().split(".")[0]) < 8) print("*** STOP: $rankFusion needs 8.0+ ***");
  print("databases: " + db.adminCommand({listDatabases:1}).databases.map(d=>d.name).join(", "));
'
```

**The target `engram` database must not exist yet.** If it does, you are restoring
into something, and that is how you get duplicate-key failures and half-merged data.

### B2. Create the database users

Atlas UI → Database Access → Add New Database User. Two users:

| User | Role | Used by |
| --- | --- | --- |
| `anchorcare_migrate` | `readWriteAnyDatabase` + `dbAdminAnyDatabase` (or `atlasAdmin`) | `mongorestore`, `provision.js` |
| `anchorcare_app` | `readWrite` on database `engram` | The application. This is the one that goes in `.env` |

Eventually the four least-privilege roles from §21.2 of the cluster document replace
`anchorcare_app`. Do not try to set those up during the migration — get the data
moved first, then tighten.

### B3. Do **not** pre-create collections or indexes

This is the step people get wrong. Resist it.

`mongorestore` recreates each collection from the dump's own metadata, including the
source indexes. If you provision first, you get one of two bad outcomes:

- you run `mongorestore --drop`, which **drops the collections you just provisioned**,
  taking their indexes, validators and options with them; or
- you run it without `--drop`, and end up with a mixture of source and target index
  definitions that nobody can reason about afterwards.

**Order is: restore the data, then provision.** `db/provision.js` is built for exactly
this — it is additive, never drops anything, never edits an existing search index, and
installs a validator only where none is present.

### B4. What *does* get prepared ahead of time

| Item | When | Command |
| --- | --- | --- |
| IP access list | Now | Atlas UI (§A5) |
| Database users | Now | Atlas UI (§B2) |
| `notablescan` / "Require Indexes for All Queries" | **Confirm it is OFF now** | Atlas UI → Additional Settings. With it on, every query against the ten unindexed `mobile_*` collections fails the moment you restore them |
| Atlas Automated Embedding integration | **Now — see §5.2** | Atlas UI → project integrations. This is a per-project setting and does not come with your data |
| Everything else | After the restore | `npm run schema:provision` |

---

## 4. Phase C — Staging dry run

Do this once, end to end, against a **staging database on the target cluster**. It
costs twenty minutes and it is the difference between a calm cutover and a frantic one.

The trick: restore into a *differently named database* on the same cluster, so you
exercise the real network, the real tier, the real version and the real tooling,
without touching the namespace you will go live on.

### C1. Dump a sample

```sh
cd ~/anchorcare-migration

# A small but representative subset: the collections with the most structure
mongodump --uri="$SOURCE_URI" --db=engram \
  --collection=episodes --gzip --archive=sample-episodes.archive
mongodump --uri="$SOURCE_URI" --db=engram \
  --collection=sources --gzip --archive=sample-sources.archive
mongodump --uri="$SOURCE_URI" --db=engram \
  --collection=people --gzip --archive=sample-people.archive
```

### C2. Restore into a staging namespace

```sh
for f in sample-episodes sample-sources sample-people; do
  mongorestore --uri="$TARGET_URI" --gzip --archive="$f.archive" \
    --nsFrom='engram.*' --nsTo='engram_staging.*' \
    --writeConcern='{w:"majority"}'
done
```

`--nsFrom` / `--nsTo` is the namespace rewrite. It is also how you would relocate
`demo_scenarios` out of the production database later (§5.14).

### C3. Validate the staging restore

```sh
# counts match?
mongosh "$TARGET_URI" --quiet --eval '
  ["episodes","sources","people"].forEach(n =>
    print(`${n}: ${db.getSiblingDB("engram_staging").getCollection(n).countDocuments({})}`));
'

# same question, against the source, same output format
mongosh "$SOURCE_URI" --quiet --eval '
  ["episodes","sources","people"].forEach(n =>
    print(`${n}: ${db.getSiblingDB("engram").getCollection(n).countDocuments({})}`));
'
```

Or let the tool do it:

```sh
SOURCE_URI="$SOURCE_URI" MONGODB_URI="$TARGET_URI" \
  node db/migration-verify.js --db engram_staging
```

> `migration-verify.js` compares both sides directly: exact counts, an
> order-independent checksum of the `_id` set, index parity by key pattern, and
> validator presence. With `--deep` it hashes every document field-by-field. It
> writes nothing to either cluster.

### C4. Validate the schema machinery on staging

```sh
MONGODB_DATABASE=engram_staging MONGODB_URI="$TARGET_URI" npm run schema:plan
MONGODB_DATABASE=engram_staging MONGODB_URI="$TARGET_URI" npm run schema:provision
```

Watch for:

- **time-series collections created** — four of them. If `createCollection` with
  `timeseries` options errors, your target version is wrong.
- **views created** — `patient_utterances`, `inference_review_queue`.
- **search indexes requested** — the script prints that builds are asynchronous and
  does not claim they are ready.
- **the no-TTL sweep passing** — if it fails here, a TTL index came across in the
  restore and §5.7 applies.

### C5. Validate the application against staging

```sh
# A scratch env file, never committed
cat > .env.staging <<'EOF'
STORE=mongodb
MONGODB_URI=mongodb+srv://anchorcare_app:<pw>@engram-prod.xxxxx.mongodb.net/
MONGODB_DATABASE=engram_staging
EMBEDDING_MODE=auto
HYBRID_BACKEND=native
SEARCH_INDEX=episodes_text
VECTOR_INDEX=episodes_auto
NATIVE_RERANK=false
ADMIN_TOKEN=<staging-admin-token>
COMPANION_TOKEN=<staging-companion-token>
TIMEZONE=Europe/London
EOF

# Wait for the search indexes to report READY first (§D5), then:
npm run atlas:check --prefix engram-retrieval
```

`atlas:check` executes the native pipeline against the real cluster and exits
non-zero on failure. An empty result proves execution, not retrieval quality — test
against approved, source-backed records for a meaningful answer.

### C6. Tear the staging namespace down

```sh
mongosh "$TARGET_URI" --quiet --eval 'db.getSiblingDB("engram_staging").dropDatabase()'
```

Do this before the production restore. Leaving `engram_staging` around guarantees
someone eventually points the app at it.

---

## 5. Phase D — Production migration

Total expected duration for a demo-sized dataset: **10 minutes of work, plus
however long the search indexes take to build.** That second part is not under your
control and is the reason the cutover is at step D7, not step D4.

### D0. Freeze writes

Because downtime is free, take the simplest, safest option: stop the writers.

```sh
# Stop the app, the worker and anything on a schedule.
# Local:
pkill -f "tsx server.ts" || true
pkill -f "node src/worker.js" || true

# Then CONFIRM nothing is still writing:
mongosh "$SOURCE_URI" --quiet --eval '
  const before = db.getSiblingDB("engram").episodes.countDocuments({});
  sleep(10000);
  const after = db.getSiblingDB("engram").episodes.countDocuments({});
  print(before === after ? "quiet: no writes in 10s" : `*** STILL WRITING: ${before} -> ${after} ***`);
'
```

Do not skip the confirmation. "I think I stopped it" is how you lose the five
documents written between dump and cutover.

Note the **freeze timestamp** — you need it for rollback (§6.3):

```sh
date -u +"%Y-%m-%dT%H:%M:%SZ" | tee migration-freeze-time.txt
```

### D1. Dump

```sh
cd ~/anchorcare-migration
STAMP=$(date +%Y%m%d-%H%M%S)

mongodump \
  --uri="$SOURCE_URI" \
  --db=engram \
  --gzip \
  --archive="engram-${STAMP}.archive" \
  --numParallelCollections=4 \
  --readPreference=primary \
  2>&1 | tee "migration-dump-${STAMP}.log"

ls -lh "engram-${STAMP}.archive"
```

| Flag | Why |
| --- | --- |
| `--archive=` + `--gzip` | One compressed file instead of a directory tree. Easier to copy, checksum and keep as your rollback artefact |
| `--readPreference=primary` | Writes are frozen, so read the primary and get the authoritative copy. (`secondaryPreferred` is for dumping a live cluster without loading the primary — not your case) |
| `--numParallelCollections=4` | Faster; harmless at this size |
| **no `--oplog`** | `--oplog` captures concurrent writes for a point-in-time dump. You froze writes, so there are none. Adding it requires extra privileges for no benefit |

Also dump the `test` database separately — decide its fate later, but do not lose it:

```sh
mongodump --uri="$SOURCE_URI" --db=test --gzip --archive="test-db-${STAMP}.archive"
```

Checksum and copy the archives somewhere that is not this laptop:

```sh
shasum -a 256 engram-${STAMP}.archive | tee engram-${STAMP}.sha256
```

### D2. Restore

```sh
mongorestore \
  --uri="$TARGET_URI" \
  --gzip \
  --archive="engram-${STAMP}.archive" \
  --nsInclude='engram.*' \
  --nsExclude='engram.demo_scenarios' \
  --numParallelCollections=4 \
  --writeConcern='{w:"majority"}' \
  --stopOnError \
  2>&1 | tee "migration-restore-${STAMP}.log"
```

| Flag | Why |
| --- | --- |
| `--nsExclude='engram.demo_scenarios'` | Demo fixtures do not belong in the same database as patient records (§5.14). Omit the flag if you want them |
| `--writeConcern='{w:"majority"}'` | A restore acknowledged by one node is not a restore |
| `--stopOnError` | Fail loudly on the first problem instead of producing a silently partial database |
| **no `--drop`** | There is nothing to drop — the target database is new. Using `--drop` later, after provisioning, destroys your indexes and validators |

Read the log. `mongorestore` reports per-collection document counts and index builds;
any `error` line is a reason to stop.

### D3. Verify the data before touching anything else

```sh
SOURCE_URI="$SOURCE_URI" MONGODB_URI="$TARGET_URI" npm run schema:migrate-verify
```

Expect `PASS — N collection(s), M document(s) verified identical on both clusters.`

Then the strong version, before you ever decommission the source:

```sh
SOURCE_URI="$SOURCE_URI" MONGODB_URI="$TARGET_URI" npm run schema:migrate-verify -- --deep
```

`--deep` hashes every field of every document rather than just the `_id` set. At demo
scale it costs seconds. **If this does not pass, do not continue.** Go to §6.

### D4. Provision the new schema

```sh
export MONGODB_URI="$TARGET_URI"
export MONGODB_DATABASE=engram

npm run atlas:indexes --prefix engram-retrieval   # the original 18 collections
npm run schema:plan                                # review: nothing is applied
npm run schema:provision                           # apply
```

`provision.js` exits non-zero on any failure, including a TTL index found on a
protected collection. Read the output to the end — it finishes with the role grants
it cannot make for you and the Online Archive caveat.

### D5. Wait for the search indexes

**This is the step that determines whether your demo works.**

```sh
mongosh "$TARGET_URI" --quiet --eval '
  const d = db.getSiblingDB("engram");
  const want = {
    episodes:           ["episodes_text","episodes_auto","episodes_visual"],
    semantic_nodes:     ["semantic_text","semantic_auto"],
    life_chapters:      ["chapters_text","chapters_auto"],
    procedures:         ["procedures_text"],
    conversation_turns: ["conversation_text","conversation_auto"]
  };
  let pending = 0;
  for (const [coll, names] of Object.entries(want)) {
    let live = [];
    try { live = d.getCollection(coll).aggregate([{$listSearchIndexes:{}}]).toArray(); } catch (e) {}
    for (const n of names) {
      const i = live.find(x => x.name === n);
      if (!i) { print(`MISSING   ${coll}.${n}`); pending++; }
      else if (!i.queryable) { print(`BUILDING  ${coll}.${n}  (${i.status})`); pending++; }
      else print(`READY     ${coll}.${n}`);
    }
  }
  print(pending ? `\n*** ${pending} index(es) not queryable — DO NOT CUT OVER YET ***` : "\nAll search indexes queryable.");
'
```

Re-run until it reports all queryable. Builds are asynchronous and Atlas gives no
completion callback.

> **Why this matters more than it looks.** If you cut over while `episodes_auto` is
> still building, hybrid retrieval returns nothing, and the companion says *"I don't
> have a memory of that"* — about memories that exist. That is a false negative a
> person with dementia has no way to challenge, and it is the exact failure
> §12.2 of the schema document is written to prevent. An index that exists is not an
> index that works.

### D6. Backfill the new layers

```sh
npm run schema:backfill                      # dry run, prints the plan
node db/backfill-semantic.js --apply         # writes DRAFTS only
npm run schema:reconcile                     # divergence + invariant report
```

Everything the backfill writes is `reviewStatus: "draft"`, so patient-facing
behaviour cannot change until a caregiver approves. Every backfilled person node gets
`lifeStatus: "unknown"` and `disclosure.policy: "defer_to_caregiver"` — set those
properly in the console before approving anything.

### D7. Cut over

Two files. No code changes.

```sh
# Root .env
MONGODB_URI=mongodb+srv://anchorcare_app:<pw>@engram-prod.xxxxx.mongodb.net/?retryWrites=true&w=majority&appName=anchorcare
MONGODB_DATABASE=engram

# engram-retrieval/.env  — same two lines
MONGODB_URI=mongodb+srv://anchorcare_app:<pw>@engram-prod.xxxxx.mongodb.net/?retryWrites=true&w=majority&appName=anchorcare
MONGODB_DATABASE=engram
```

Also update, if you use them: the Docker environment (`Dockerfile`, `docs/DEPLOYMENT.md`),
any hosting provider's secret store, and any teammate's local `.env`.

```sh
# Confirm the app is pointing where you think it is, BEFORE starting it
node -e 'require("dotenv").config();
  const u = process.env.MONGODB_URI || "";
  console.log("host:", (u.match(/@([^/?]+)/)||[])[1], "| db:", process.env.MONGODB_DATABASE);'
```

Restart:

```sh
npm start                                  # app
npm run worker --prefix engram-retrieval   # worker
```

---

## 6. Phase E — Post-migration validation

Run these in order. Each one exercises a layer the previous one does not.

### E1. Connectivity and inventory

```sh
npm run schema:audit-live
```

Expect: no P0 findings, the `test` database flagged if you did not migrate it, and
far fewer `unindexed_collection` findings than the source had.

### E2. Ingestion

```sh
npm run demo:seed-atlas          # writes fictional, caregiver-approved records
npm run demo:verify-atlas
```

### E3. Retrieval, including hybrid

```sh
npm run atlas:check --prefix engram-retrieval
```

This executes the native `$rankFusion` pipeline for real. Confirm the response
reports `featuresUsed` containing `atlas_rank_fusion` and
`atlas_automated_embedding_voyage` (or `voyage_embeddings` in manual mode). **Claim
only the features a live run actually reported** — index configuration is not proof
of execution.

### E4. Search, vector and graph

```sh
mongosh "$TARGET_URI" --quiet --eval '
  const d = db.getSiblingDB("engram");
  // text
  print("search hits:  " + d.episodes.aggregate([
    {$search:{index:"episodes_text",compound:{must:[{text:{query:"garden",path:"searchText"}}],
      filter:[{equals:{path:"reviewStatus",value:"approved"}}]}}},{$limit:5},{$count:"n"}]).toArray()[0]?.n ?? 0);
  // vector
  print("vector hits:  " + d.episodes.aggregate([
    {$vectorSearch:{index:"episodes_auto",path:"searchText",query:{text:"tea in the garden"},
      numCandidates:100,limit:5,filter:{reviewStatus:"approved",isCurrent:true}}},{$count:"n"}]).toArray()[0]?.n ?? 0);
  // graph
  print("graph nodes:  " + d.semantic_nodes.countDocuments({}));
'
```

Zero hits on a database that has approved episodes means the index is not queryable
yet, or the filter fields are not declared in the index definition. Go back to D5.

### E5. TTL collections

TTL is the one behaviour you cannot test by reading — you have to watch something
disappear.

```sh
mongosh "$TARGET_URI" --quiet --eval '
  const d = db.getSiblingDB("engram");
  // TTL indexes that SHOULD exist
  ["working_memory","working_sessions","ts_dedupe","active_tasks","inferences","mobile_pairings"]
    .forEach(n => {
      const ttl = d.getCollection(n).getIndexes().filter(i => i.expireAfterSeconds !== undefined);
      print(`${n.padEnd(20)} ${ttl.length ? ttl.map(i=>i.name+"("+i.expireAfterSeconds+"s"+(i.sparse?",sparse":"")+")").join(" ") : "*** NO TTL ***"}`);
    });
  print("");
  // TTL indexes that must NOT exist
  ["care_alerts","safety_constraints","medication_responses","audit_events","procedure_runs",
   "consent_records","symptom_ts","conversation_turns","conversation_sessions","mobile_sos"]
    .forEach(n => {
      const ttl = d.getCollection(n).getIndexes().filter(i => i.expireAfterSeconds !== undefined);
      if (ttl.length) print(`*** ${n}: TTL PRESENT — ${ttl.map(i=>i.name).join(",")} — REMOVE IT ***`);
    });
  print("no-TTL check complete");
'
```

Then watch one actually expire:

```sh
mongosh "$TARGET_URI" --quiet --eval '
  const d = db.getSiblingDB("engram");
  d.ts_dedupe.insertOne({_id:"ttl_probe_"+Date.now(), series:"probe", sourceEventId:"probe",
                         expiresAt:new Date(Date.now()-1000)});
  print("probe inserted, expiresAt in the past. Re-run the count in ~90s:");
  print("count now: " + d.ts_dedupe.countDocuments({_id:/^ttl_probe_/}));
'
# wait 90 seconds (the TTL monitor runs every 60s), then:
mongosh "$TARGET_URI" --quiet --eval '
  print("count after: " + db.getSiblingDB("engram").ts_dedupe.countDocuments({_id:/^ttl_probe_/}));
'
```

`0` means the TTL monitor is running. A non-zero count after three minutes means TTL
is not working and `working_memory` will grow without bound.

### E6. Safety collections

```sh
npm run schema:reconcile    # invariants a validator cannot express
npm run schema:audit        # audit hash-chain walk
```

Then confirm the validators actually reject bad writes — the whole point of them:

```sh
mongosh "$TARGET_URI" --quiet --eval '
  const d = db.getSiblingDB("engram");
  // an alert with no evidence must be refused
  try {
    d.care_alerts.insertOne({householdId:"t",subjectId:"t",idempotencyKey:"probe",
      alertType:"manual",severity:"info",state:"raised",
      transitions:[{to:"raised",at:new Date(),by:"probe"}],
      triggerRefs:[],evidenceSummary:"probe",createdAt:new Date()});
    print("*** VALIDATOR NOT ENFORCED: an alert with no evidence was accepted ***");
    d.care_alerts.deleteOne({idempotencyKey:"probe"});
  } catch (e) { print("ok: care_alerts rejected an alert with no evidence"); }
  // a patient-visible inference must be impossible
  try {
    d.inferences.insertOne({householdId:"t",subjectId:"t",inferenceType:"topic",claim:{},
      claimDigest:"p",epistemicStatus:"inferred",calibration:"uncalibrated",
      visibility:"patient",basis:[{store:"working",id:"x"}],
      firstObservedAt:new Date(),lastObservedAt:new Date(),recordedAt:new Date()});
    print("*** VALIDATOR NOT ENFORCED: visibility:patient was accepted ***");
    d.inferences.deleteOne({claimDigest:"p"});
  } catch (e) { print("ok: inferences rejected visibility:patient"); }
'
```

### E7. Slow queries

Leave this running for the first day on the new cluster:

Atlas UI → cluster → **Performance Advisor**, and **Profiler** with slow-query
logging on. The collections to watch are the ones that had no indexes until this
migration: `mobile_sos`, `mobile_commands`, `mobile_devices`, `medication_responses`,
`memory_images`. If the Performance Advisor suggests an index on any of them, compare
it against `db/collections.js` — either the registry is missing a query pattern, or
the code is doing something the schema did not anticipate. Both are worth knowing.
---

## 7. What might break, and exactly what to change

Ordered by how likely it is to bite you, not by severity.

### 7.1 Atlas Search and Vector Search indexes do not migrate — **certain**

**What breaks:** All hybrid retrieval. `$search` and `$vectorSearch` against a
non-existent index error; against a *building* index they return nothing. The
companion reports "I don't have a memory of that" for memories that exist.

**Why:** No migration tool moves them. Live Migration explicitly does not;
`mongosync` explicitly does not; `mongodump` never did. They live in Atlas's search
metadata, not in the collection.

**Fix:**
```sh
npm run atlas:indexes --prefix engram-retrieval   # episodes_text, episodes_auto
npm run schema:provision                           # the other 8
# then poll until queryable — see §D5
```
**Do not cut over until every index reports `queryable: true`.**

---

### 7.2 Atlas Automated Embedding is a per-project integration — **very likely**

**What breaks:** `episodes_auto`, `semantic_auto` and `chapters_auto` use
`{ type: "autoEmbed", model: "voyage-4" }`. Automated Embedding is configured per
Atlas **project**. Your friend's project is a different project, so the integration
does not exist there. Index creation may fail outright, or the index builds and
every query returns nothing.

**This is the failure most likely to be mistaken for "the migration lost my data."**

**Fix, option A — enable the integration (preferred):**
Atlas UI → the new project → integrations → enable Voyage AI / Automated Embedding,
then re-run `npm run schema:provision`.

**Fix, option B — switch to manual embeddings:**
```dotenv
EMBEDDING_MODE=manual
VOYAGE_API_KEY=<your key>
VOYAGE_EMBED_MODEL=voyage-4
VOYAGE_DIMENSIONS=1024
VECTOR_INDEX=episodes_manual      # a NEW name — never edit an existing search index
```
Then re-provision. `engram-retrieval/src/store.js` already branches on
`EMBEDDING_MODE` and will populate `embedding` on write; `vectorPipeline()` already
switches `path` from `searchText` to `embedding`. **No code change** — but existing
episodes have no `embedding` field, so you must re-embed them, or accept that vector
recall only covers records written after the switch.

> Changing `EMBEDDING_MODE` without changing `VECTOR_INDEX` is the one way to
> create a silently broken index: the definition no longer matches the mode.
> `NATIVE-ATLAS.md` already states this rule; it applies with full force here.

---

### 7.3 Target MongoDB version below 8.0 — **likely if your friend uses defaults**

**What breaks:** `$rankFusion` requires 8.0+. Every hybrid recall fails. The service
falls back to application-side rank fusion and reports
`application_reciprocal_rank_fusion` instead of `atlas_rank_fusion` — degraded, and
your demo claim about native fusion becomes false.

**Fix:** Create the cluster on **8.0**, pinned. Check:
```sh
mongosh "$TARGET_URI" --quiet --eval 'print(db.version())'
```
If it is already 7.x, upgrade the cluster in the Atlas UI before migrating. If you
cannot, set `HYBRID_BACKEND=application` so the fallback is explicit rather than a
surprise, and do not claim native fusion.

---

### 7.4 "Require Indexes for All Queries" (`notablescan`) — **project-dependent**

**What breaks:** Every query against the ten `mobile_*` / `demo_scenarios` /
`integration_requests` collections, which have no indexes until `schema:provision`
runs. Including the SOS path.

**Fix:** Atlas UI → cluster → Additional Settings → confirm it is **off** before the
restore. Turn it on, if you want it, only after `npm run schema:provision` and
`npm run schema:audit-live` both come back clean.

---

### 7.5 Users and roles do not migrate — **certain**

**What breaks:** Authentication. `MONGODB_URI` contains credentials that do not
exist in the new project.

**Fix:** Create `anchorcare_app` (§B2), then update **both** `.env` files
(root and `engram-retrieval/`). Also: Atlas database users are scoped to a project,
so the old credential is not merely wrong — it does not exist.

---

### 7.6 IP access list is empty on a new project — **certain**

**What breaks:** `MongoServerSelectionError: ... connection timed out`. Looks like a
dead cluster; it is a firewall.

**Fix:**
```sh
curl -s ifconfig.me          # add this to the new project's IP Access List
```
Add your deploy host too. Never `0.0.0.0/0`.

---

### 7.7 TTL behaviour changes after provisioning — **expected, verify anyway**

**What changes:** `schema:provision` adds TTL indexes that did not exist on the
source:

| Collection | TTL | Effect on restored data |
| --- | --- | --- |
| `mobile_pairings` | `expiresAt`, 3600s grace | **Old pairing codes are deleted within ~60s of the build.** Correct — they are expired five-minute credentials — but the count will drop. Do not mistake it for data loss |
| `working_memory`, `working_sessions`, `ts_dedupe` | `expiresAt`, 0s | No source data; nothing to delete |
| `active_tasks`, `inferences` | `expiresAt`, 0s, **sparse** | Documents without `expiresAt` are untouched. That is the mechanism protecting tier-2 tasks and clinical inferences |

**What could break:** if the source carried a TTL index on a collection in `NO_TTL`,
`mongorestore` brings it across and `schema:provision` **fails with a P0**. That is
the alarm working.

**Fix if it fires:**
```sh
mongosh "$TARGET_URI" --quiet --eval '
  db.getSiblingDB("engram").<collection>.dropIndex("<index name>")'
```
Then re-run `npm run schema:provision`, and work out how it got onto the source.

---

### 7.8 Schema validators — **low risk by design, but know why**

**What could break:** a validator rejecting restored documents.

**Why it will not:** `provision.js` installs a validator only on collections it
*creates*, and only via `collMod` where none exists. Every collection that receives
restored data (`episodes`, `sources`, `plans`, `people`, `daily_logs`,
`personal_records`, `medication_responses`, `memory_images`, all ten device-link
collections) is marked `existing: true` **with no validator in the registry**. This
was deliberate.

**What to watch:** new writes to new collections must satisfy the validators — that
is the point. If the app starts throwing `Document failed validation` after cutover,
the failing write is genuinely malformed; read the validator in `db/collections.js`
rather than removing it.

---

### 7.9 Index name collisions — **cosmetic**

**What happens:** `engram-retrieval/scripts/indexes.js` creates unnamed indexes
(Atlas auto-names them `householdId_1_subjectId_1_...`). `db/collections.js` uses
explicit names like `companion_read_path`.

**Why it is fine:** `provision.js` matches on *key pattern* or name, so it skips an
index that already exists under a different name. No duplicates.

**If you do see two indexes on identical keys:** drop the auto-named one.
```sh
mongosh "$TARGET_URI" --quiet --eval '
  db.getSiblingDB("engram").episodes.getIndexes().forEach(i => print(i.name, JSON.stringify(i.key)))'
```

---

### 7.10 GridFS images — **silent if it breaks**

**What breaks:** `memory_images` documents carry `gridFsId` pointing into
`engram_images.chunks`. If the two GridFS collections do not restore cleanly, image
reads throw and the caregiver console shows broken photos — with no error anywhere
near the cause.

**Fix / verify:**
```sh
mongosh "$TARGET_URI" --quiet --eval '
  const d = db.getSiblingDB("engram");
  print("files:  " + d.getCollection("engram_images.files").countDocuments({}));
  print("chunks: " + d.getCollection("engram_images.chunks").countDocuments({}));
  const idx = d.getCollection("engram_images.chunks").getIndexes().map(i => JSON.stringify(i.key));
  print("chunks idx: " + idx.join(" "));
  if (!idx.some(k => k.includes("files_id"))) {
    print("*** missing {files_id:1,n:1} — creating it ***");
    d.getCollection("engram_images.chunks").createIndex({files_id:1,n:1},{unique:true});
  }
'
```

---

### 7.11 Connection pool and timeouts — **only if the region changed**

`engram-retrieval/src/store.js` connects with `serverSelectionTimeoutMS: 10000` and
the driver default `maxPoolSize: 100`.

| Situation | What to change |
| --- | --- |
| New cluster in the **same region** | Nothing |
| New cluster in a **different region/continent** | Raise `serverSelectionTimeoutMS` to `20000` in `store.js`; expect every retrieval to be slower — the §12.8 latency budget assumes co-location |
| Target is a **smaller tier** than the source | Lower `maxPoolSize` in the connection string: `&maxPoolSize=20`. M10 allows 1500 connections, so this is only a concern if several services share the cluster |
| Serverless/Flex target | Do not. Several features this schema needs are unavailable |

---

### 7.12 Write and read concern — **no change needed**

New code paths use `{ w: "majority", j: true }` for safety writes. Every Atlas M10+
cluster is a three-node replica set, so majority writes behave identically on the new
cluster. Nothing to change. Worth confirming the target is not a single-node
configuration:

```sh
mongosh "$TARGET_URI" --quiet --eval '
  print("members: " + db.adminCommand({hello:1}).hosts.length)'
```

---

### 7.13 The `test` database — **a decision, not a bug**

`alerts`, `conversations`, `memories` are not written by this codebase.
`createStore()` always passes `MONGODB_DATABASE`, so they came from somewhere else:
a teammate's service, a Compass session, or a connection string with no database path.

**Before you migrate, find out whose it is.** The three names map almost exactly onto
`care_alerts`, `conversation_turns` and `episodes` — if a teammate is building a
parallel implementation, migrating it silently creates two sources of truth in the
new cluster.

| Decision | Action |
| --- | --- |
| It is a teammate's live work | Migrate it as its own database: `mongorestore --nsFrom='test.*' --nsTo='test.*'`, and schedule a conversation about convergence |
| It is scratch | Leave it. You already have `test-db-<stamp>.archive` if you are wrong |
| Nobody knows | Keep the archive, do not migrate, revisit after the demo |

---

### 7.14 `demo_scenarios` in the production database — **hygiene**

Seed fixtures from `integration/seed-*.ts` sit alongside patient records.

**Fix (restore them to their own database):**
```sh
mongorestore --uri="$TARGET_URI" --gzip --archive="engram-${STAMP}.archive" \
  --nsInclude='engram.demo_scenarios' --nsFrom='engram.*' --nsTo='engram_demo.*'
```
Then point the seed scripts at `MONGODB_DATABASE=engram_demo` when you run them.

---

### 7.15 Online Archive and erasure — **not now, but do not forget**

Do **not** configure Online Archive during this migration. When you do:

- archived data leaves the cluster and is **not searchable** by `$search` or
  `$vectorSearch`;
- archived documents **cannot be deleted individually** — an erasure request means
  restore-via-`$merge`, delete, drop the archive, recreate it;
- GridFS cannot be archived at all.

§23 of the cluster document has the full runbook. Migrating first and archiving later
is the correct order.

---

## 8. Rollback

### 8.1 When to roll back

Roll back immediately if any of these are true:

| Trigger | Why it is a rollback and not a fix-forward |
| --- | --- |
| `schema:migrate-verify` fails after the restore | You do not know what is missing. Do not build on an unknown base |
| `--deep` verification fails | Documents differ field-by-field. Something is silently wrong |
| Search indexes still not queryable after ~30 minutes | Something is wrong with the project, tier or integration |
| The app throws authentication or validation errors you cannot explain in 10 minutes | Debug with the old cluster serving, not with the demo in an hour |
| Retrieval returns empty for a query you know has an answer | §7.1 or §7.2. Roll back, fix, re-cut |

### 8.2 How to roll back — the easy case

**You never wrote to the source during migration**, and writes were frozen at D0.
The source is a perfect point-in-time copy of the moment you froze. So:

```sh
# 1. Stop the app and worker
pkill -f "tsx server.ts" || true
pkill -f "node src/worker.js" || true

# 2. Put the OLD connection string back in both .env files
#    root/.env  and  engram-retrieval/.env
MONGODB_URI=mongodb+srv://<old-user>:<pw>@<old-cluster>.xxxxx.mongodb.net/
MONGODB_DATABASE=engram

# 3. Confirm you are pointing at the old cluster
node -e 'require("dotenv").config();
  console.log("host:", (process.env.MONGODB_URI.match(/@([^/?]+)/)||[])[1]);'

# 4. Restart
npm start
npm run worker --prefix engram-retrieval
```

Total rollback time: under two minutes. This works because the migration is
**read-only on the source** from beginning to end. Keep it that way: do not
"clean up" the old cluster, do not drop anything, until the new one has been running
for a week.

### 8.3 Rolling back after writes have landed on the new cluster

Harder, and the reason you recorded the freeze timestamp in D0.

```sh
FREEZE=$(cat migration-freeze-time.txt)

# What was written to the new cluster after the freeze?
mongosh "$TARGET_URI" --quiet --eval "
  const d = db.getSiblingDB('engram');
  const t = new Date('$FREEZE');
  ['episodes','sources','conversation_turns','daily_logs','medication_responses',
   'care_alerts','audit_events','mobile_sos'].forEach(n => {
    const field = ['audit_events'].includes(n) ? 'at' : 'recordedAt';
    const q = {}; q[field] = {\$gte: t};
    const c = d.getCollection(n).countDocuments(q);
    if (c) print(n + ': ' + c + ' document(s) written after the freeze');
  });
"
```

If the counts are zero, use §8.2 — nothing was lost.

If they are not zero, you have a genuine choice:

| Option | When |
| --- | --- |
| **Roll forward**: fix the problem on the new cluster | Almost always right. The new cluster has the data *and* the new schema |
| **Export the delta and replay onto the old cluster** | Only if the new cluster is unusable |

```sh
# export the delta
mongodump --uri="$TARGET_URI" --db=engram --collection=episodes \
  --query="{\"recordedAt\":{\"\$gte\":{\"\$date\":\"$FREEZE\"}}}" \
  --gzip --archive=delta-episodes.archive
# then restore onto the old cluster
mongorestore --uri="$SOURCE_URI" --gzip --archive=delta-episodes.archive
```

Repeat per collection. This is tedious on purpose — it is the path you want to avoid,
and §8.2 is why you can.

### 8.4 Restoring from the archive

The archive is a complete, standalone copy. It restores onto any cluster:

```sh
shasum -a 256 -c engram-${STAMP}.sha256          # verify it first
mongorestore --uri="<any cluster>" --gzip --archive="engram-${STAMP}.archive" \
  --nsFrom='engram.*' --nsTo='engram.*'
```

Keep it for at least 30 days after the migration, off the laptop, and treat it as
sensitive — it contains narrative about a person's life.

### 8.5 Decommissioning the old cluster

Not for at least **seven days** of the new cluster running clean, and not before:

- [ ] `npm run schema:migrate-verify -- --deep` passes
- [ ] `npm run schema:audit-live` shows no P0 findings on the new cluster
- [ ] The archive is checksummed and stored somewhere that is not your laptop
- [ ] An Atlas snapshot of the old cluster exists and you know how to restore it
- [ ] Your teammate has confirmed what the `test` database was

---

## 9. The checklist

Print this. Tick as you go.

### Before the day

- [ ] `mongodump --version` reports 100.9 or newer
- [ ] Source size and per-collection counts recorded (§0.1) → `migration-source-inventory.txt`
- [ ] `MONGODB_URI="$SOURCE_URI" npm run schema:audit-live` captured
- [ ] Friend has created the cluster: **M10, MongoDB 8.0 pinned, right region** (§11.2 — *not* M30)
- [ ] **Auto-scaling OFF** on the new cluster (§11.2) — the fastest way to lose 100 credits overnight
- [ ] **No dedicated Search Nodes** provisioned; coupled search is correct for a demo (§11.2)
- [ ] Online Archive **not** configured (§11.4)
- [ ] Friend has granted you **Project Owner** (or Data Access Admin + Cluster Manager)
- [ ] `anchorcare_migrate` and `anchorcare_app` database users created
- [ ] Your IP on the new project's access list; **not** `0.0.0.0/0`
- [ ] "Require Indexes for All Queries" confirmed **off**
- [ ] Automated Embedding integration enabled in the new project — **or** you have decided on `EMBEDDING_MODE=manual` with a new index name
- [ ] `*.archive` added to `.gitignore`
- [ ] **Embedding mode decided before any index is created** (§0.2 step 7, §7.2, **§14**)
- [ ] Friend has followed §15 in the Atlas UI and sent back the four confirmations
- [ ] Staging dry run completed end to end (§Phase C), then `engram_staging` dropped

### Migration day

- [ ] **D0** App, worker, schedules, hosting deployment, teammates' local envs and the mobile PWA all stopped (§12.3)
- [ ] **D0** 30-second quiet check passed across all watched collections (§12.3)
- [ ] **D0** Freeze timestamp recorded → `migration-freeze-time.txt`
- [ ] **A4** Atlas on-demand snapshot of the source taken
- [ ] **D1** `mongodump` completed; archive checksummed; copied off the laptop
- [ ] **D1** `test` database dumped separately
- [ ] **D2** `mongorestore` completed with `--stopOnError`; log read to the end
- [ ] **D3** `npm run schema:migrate-verify` → PASS
- [ ] **D3** `npm run schema:migrate-verify -- --deep` → PASS
- [ ] **D4** `npm run atlas:indexes --prefix engram-retrieval`
- [ ] **D4** `npm run schema:plan` reviewed, then `npm run schema:provision` → exit 0
- [ ] **D5** All 10 search indexes report `queryable: true` ← **do not proceed before this**
- [ ] **D5** Time-series collections confirmed as actual time-series (§13.1)
- [ ] **D6** `node db/backfill-semantic.js --apply`; `npm run schema:reconcile` reviewed
- [ ] **D6** A `consent_records` document exists for each subject:
      `node db/seed-consent.js --subject <id> --granted-by "<name>" --kind subject --apply` (§13.3)
- [ ] **D7** Both `.env` files updated; connection target confirmed by the `node -e` check
- [ ] **D7** App and worker restarted
- [ ] **D7** **Write access revoked on the OLD cluster** — app user set to read-only, probe confirms (§12.4)

### Same day, after cutover

- [ ] **E1** `npm run schema:audit-live` → no P0 (now also checks FCV vs version and consent coverage)
- [ ] **E2** `npm run demo:seed-atlas` then `npm run demo:verify-atlas`
- [ ] **E3** `npm run atlas:check --prefix engram-retrieval` → reports `atlas_rank_fusion`
- [ ] **E4** Text, vector and graph probes all return non-zero
- [ ] **E5** TTL probe disappears within 90 seconds; no TTL on any `NO_TTL` collection
- [ ] **E6** `npm run schema:reconcile` and `npm run schema:audit` reviewed
- [ ] **E6** Validator probes rejected both bad writes
- [ ] **E7** Performance Advisor and Profiler enabled

### The week after

- [ ] Old cluster left running, **app user read-only**, or paused to save credits (§11.5, §12.5)
- [ ] Admin credential for the old cluster is in no `.env` and no teammate's hands (§12.5)
- [ ] Archive stored off-laptop, checksum verified
- [ ] `test` database ownership resolved
- [ ] Least-privilege roles from §21.2 replacing the single `anchorcare_app` user
- [ ] Only then: decommission the old cluster

---

## 10. Command reference

```sh
# ─── environment ────────────────────────────────────────────────────────────
export SOURCE_URI='mongodb+srv://<old-user>:<pw>@<old-cluster>.xxxxx.mongodb.net/'
export TARGET_URI='mongodb+srv://anchorcare_migrate:<pw>@engram-prod.xxxxx.mongodb.net/'
# db/migration-verify.js and db/audit-live.js also accept the explicit pair:
export MONGODB_URI_OLD="$SOURCE_URI"
export MONGODB_URI_NEW="$TARGET_URI"
export STAMP=$(date +%Y%m%d-%H%M%S)

# ─── measure ────────────────────────────────────────────────────────────────
mongosh "$SOURCE_URI" --quiet --eval 'print(db.version())'
mongosh "$TARGET_URI" --quiet --eval 'print(db.version())'

# ─── dump ───────────────────────────────────────────────────────────────────
mongodump --uri="$SOURCE_URI" --db=engram --gzip \
  --archive="engram-${STAMP}.archive" --numParallelCollections=4 \
  --readPreference=primary | tee "migration-dump-${STAMP}.log"
shasum -a 256 "engram-${STAMP}.archive" | tee "engram-${STAMP}.sha256"

# ─── restore ────────────────────────────────────────────────────────────────
mongorestore --uri="$TARGET_URI" --gzip --archive="engram-${STAMP}.archive" \
  --nsInclude='engram.*' --nsExclude='engram.demo_scenarios' \
  --numParallelCollections=4 --writeConcern='{w:"majority"}' --stopOnError \
  | tee "migration-restore-${STAMP}.log"

# ─── verify ─────────────────────────────────────────────────────────────────
SOURCE_URI="$SOURCE_URI" MONGODB_URI="$TARGET_URI" npm run schema:migrate-verify
SOURCE_URI="$SOURCE_URI" MONGODB_URI="$TARGET_URI" npm run schema:migrate-verify -- --deep

# ─── schema ─────────────────────────────────────────────────────────────────
export MONGODB_URI="$TARGET_URI" MONGODB_DATABASE=engram
npm run atlas:indexes --prefix engram-retrieval
npm run schema:plan
npm run schema:provision
npm run schema:backfill          # dry run
node db/backfill-semantic.js --apply
npm run schema:reconcile
npm run schema:audit
npm run schema:audit-live

# ─── consent (requires a named grantor; refuses without one) ────────────────
node db/seed-consent.js --subject margaret --granted-by "Margaret Doyle" --kind subject
node db/seed-consent.js --subject margaret --granted-by "Margaret Doyle" --kind subject --apply

# ─── cutover ────────────────────────────────────────────────────────────────
# edit .env and engram-retrieval/.env, then:
node -e 'require("dotenv").config();
  console.log("host:", (process.env.MONGODB_URI.match(/@([^/?]+)/)||[])[1],
              "| db:", process.env.MONGODB_DATABASE);'
npm start
npm run worker --prefix engram-retrieval

# ─── rollback ───────────────────────────────────────────────────────────────
# put the old MONGODB_URI back in both .env files and restart. That is the whole
# rollback, because the migration never wrote to the source.
```

### Example connection strings

```dotenv
# Old cluster (keep this line commented in .env after cutover — it is your rollback)
# MONGODB_URI=mongodb+srv://engram_user:<pw>@engramdemo.abc12.mongodb.net/

# New cluster, application user
MONGODB_URI=mongodb+srv://anchorcare_app:<pw>@engram-prod.xy789.mongodb.net/?retryWrites=true&w=majority&appName=anchorcare
MONGODB_DATABASE=engram
```

Note there is **no database path** in the URI — the trailing `/` is deliberate, and
`MONGODB_DATABASE` selects the database. A URI like `...mongodb.net/test` would
override it and is the most likely explanation for how a `test` database appeared on
the old cluster in the first place.
---

## 11. Cost model: making 100 Atlas credits last

This section **supersedes §22.2 of `REALTIME-CAPTURE-AND-CLUSTER.md` for the demo
phase.** That section recommends M30 with two dedicated S30 Search Nodes, which is the
right production answer and the wrong answer on a 100-credit budget. The difference
matters enough to state plainly rather than leave you to discover it on the bill.

### 11.1 The arithmetic

Approximate AWS `us-east-1` list prices. **Verify current numbers in the Atlas UI
cluster-creation estimator** — the published pricing page carries figures that have
not been recalculated recently, and prices vary by region and provider.

| Component | ≈ hourly | ≈ monthly | 100 credits lasts |
| --- | --- | --- | --- |
| **M10** (2 GB RAM, 10 GB storage) | $0.08 | ~$57 | **~1.7 months** |
| M20 (4 GB, 20 GB) | $0.20 | ~$147 | ~20 days |
| M30 (8 GB, 40 GB) | $0.54 | ~$388 | **~7.7 days** |
| Dedicated Search Nodes | billed **per node, hourly, separately from the cluster**, minimum **2** | — | meaningfully reduces all of the above |
| Backup | — | ~$0.14/GB/month | negligible at demo scale |
| Data transfer, same region | — | ~$0.01/GB | negligible |
| Data transfer, internet egress | — | ~$0.09/GB | watch this if you pull dumps repeatedly |

Two conclusions follow immediately:

1. **M30 burns the entire allowance in about a week.** Do not create one for a demo.
2. **Dedicated Search Nodes are billed separately and require a minimum of two.**
   On top of an M10 they are the largest single line item you can add, and they buy
   you workload isolation you do not need until real users are talking to the thing.

### 11.2 Recommended configuration for the demo phase

| Setting | Demo value | Production value (§22.2) | Why they differ |
| --- | --- | --- | --- |
| Tier | **M10** | M30 | M10 runs everything this schema needs. It is slower under concurrent load, which a demo does not have |
| Search | **Coupled** (`mongot` on the cluster nodes) | 2 × dedicated Search Nodes | Coupled search is what MongoDB calls prototype-grade: `mongot` shares CPU with `mongod`. For one person demoing, that is fine. It is also free |
| MongoDB version | **8.0 pinned** | 8.0 pinned | Non-negotiable either way — `$rankFusion` needs it |
| Backup | On | On | Cheap, and it is one of your three recovery points |
| Online Archive | **Off** | On, at 90 days | Requires M10+ so it is available, but it adds cost and the erasure complexity in §7.15. Not during a demo |
| Auto-scaling | **Off** | Off with a storage alert | Auto-scaling on a credit budget is how you wake up to an M30 |

**Turn auto-scaling off explicitly.** Atlas can scale an M10 up under load, and the
cluster will not scale back down on its own in a way you can rely on. On a fixed
credit allowance that is the single most likely way to lose the budget overnight.

### 11.3 Pause the cluster when you are not using it

Atlas lets you pause an M10+ cluster. A paused cluster does not accrue compute
charges; you continue to pay for storage, which at demo scale is pennies.

```
Atlas UI → cluster → ⋯ → Pause Cluster
```

For a hackathon this is the highest-leverage cost control available:

| Usage pattern | 100 credits lasts |
| --- | --- |
| M10 running continuously | ~1.7 months |
| M10 running ~8 hours a day, paused otherwise | **~5 months** |

Caveats worth knowing before you rely on it:

- A paused cluster **cannot be reached**, so every connection fails while paused.
  Pause only when nothing is scheduled to run.
- **Resuming takes several minutes.** Do not pause the night before a demo.
- Atlas resumes a paused cluster automatically after a period of inactivity in some
  configurations — check the cluster's state before assuming it is still paused.
- **Search indexes survive a pause**, but confirm they report `queryable` again after
  resuming before you demo. Use the D5 poll.

### 11.4 What to avoid provisioning

On this budget, do not create:

- **Dedicated Search Nodes** — the biggest avoidable line item.
- **M20 or above** — nothing in this schema needs it at demo scale.
- **A second cluster for staging.** Phase C deliberately uses a *staging database on
  the same cluster* (`engram_staging`), not a staging cluster, for exactly this reason.
- **Online Archive** — adds federated-instance cost and the §7.15 erasure complexity.
- **Multi-region or multi-cloud** — multiplies the cluster cost per region.

### 11.5 Where the old cluster fits

§8.5 says keep the old cluster for seven days after cutover. That is correct for
safety, and it costs money for seven days. If the old cluster is on your own billing
rather than the credits, the trade is free; if it is on the same allowance, the
seven days of an idle M10 is roughly 13 credits — worth it, and cheaper than the
alternative of having no rollback.

If you need that back: **pause the old cluster** rather than deleting it. A paused
cluster is still a complete rollback target, retains its data, and stops the compute
charge. Delete only after §8.5's checklist is fully ticked.

---

## 12. Split-brain prevention

Your brief asks how to avoid writes landing on both clusters. It is worth treating as
its own problem, because the window where both clusters are live and reachable is the
one genuinely dangerous period in this migration.

### 12.1 Why it matters here specifically

If a write lands on the old cluster after the dump, it is invisible to the new one and
`migration-verify.js` will not see it — the tool compares both clusters at a point in
time, and a write that arrives after the comparison passes silently. In this schema
that is worse than it sounds: the write-once collections (`sources`, `audit_events`,
`medication_responses`, `recall_attempts`) have no update path, so a missed insert is
not something you can reconcile later by replaying an update. It is simply gone.

The hash-chained audit log makes it visible but not recoverable: `verify-audit.js`
will report a `seq` gap on the new cluster, which tells you an event is missing
without telling you what it was.

### 12.2 The three windows, and what closes each

```
   D0 freeze ──────── D1 dump ─── D2 restore ─── D7 cutover ──────── +7 days
   │                                              │                    │
   ├── WINDOW 1 ───────────────────────────────── │                    │
   │   old cluster live and reachable,            │                    │
   │   new cluster being built                    │                    │
   │                                              ├── WINDOW 2 ────────│
   │                                              │   BOTH clusters    │
   │                                              │   live & reachable │
   │                                                                   ├── WINDOW 3
   │                                                                   │   old kept
   │                                                                   │   for rollback
```

| Window | Risk | What closes it |
| --- | --- | --- |
| **1** — freeze to cutover | A scheduled job or a teammate's laptop writes to the old cluster after the dump | §12.3: stop every writer, then verify silence |
| **2** — immediately after cutover | A stale process still holds a connection to the old cluster | §12.4: revoke access at the old cluster, not just in config |
| **3** — the rollback week | Someone "tests something" against the old cluster and diverges it | §12.5: make the old cluster read-only in fact |

### 12.3 Closing window 1 — stop every writer, then prove it

The D0 quiet check covers the app, but a hackathon repo has more writers than people
remember:

```sh
# Everything in this repo that writes:
pkill -f "tsx server.ts"              || true   # app + API
pkill -f "node src/worker.js"         || true   # prompt worker
pkill -f "memory:nightly"             || true   # rehearsal generation
pkill -f "seed-"                      || true   # any seed script mid-run
```

Then the ones that are not processes on your machine:

- [ ] Any **hosting deployment** still running (check `docs/DEPLOYMENT.md`, your
      Docker host, any Render/Railway/Fly instance)
- [ ] **Teammates' local `.env` files** pointing at the old cluster — message them;
      this is the most common source of a stray write
- [ ] Any **scheduled task** (`npm run memory:nightly` under a cron or a hosting
      scheduler — `MEMORY-MODEL.md` says it is not auto-scheduled, but confirm)
- [ ] An open **mongosh or Compass** session with an uncommitted write
- [ ] The **mobile PWA** if a phone still has it open and is polling

Then prove silence across the collections that matter, not just `episodes`:

```sh
mongosh "$SOURCE_URI" --quiet --eval '
  const d = db.getSiblingDB("engram");
  const watch = ["episodes","sources","audit_events","medication_responses",
                 "daily_logs","prompts","prompt_jobs","mobile_sos","mobile_commands"];
  const before = {}; watch.forEach(n => before[n] = d.getCollection(n).countDocuments({}));
  print("waiting 30s…"); sleep(30000);
  let moved = false;
  watch.forEach(n => {
    const after = d.getCollection(n).countDocuments({});
    if (after !== before[n]) { print(`*** ${n}: ${before[n]} -> ${after} — SOMETHING IS STILL WRITING ***`); moved = true; }
  });
  print(moved ? "NOT SAFE TO DUMP" : "quiet across all watched collections");
'
```

Thirty seconds, not ten — the prompt worker's default interval is 2 s but a scheduled
job can be minutes apart. If anything moved, find it before dumping.

### 12.4 Closing window 2 — revoke, do not just reconfigure

Changing `.env` redirects *new* connections. It does nothing about a process that is
already connected, and nothing at all about a teammate whose config you did not change.

**The reliable close is at the old cluster, not in your config.** Immediately after
the cutover in D7, do one of these on the OLD cluster:

```
Option A (preferred) — Atlas UI → Database Access → the application user →
  Edit → change role from readWrite to READ ONLY on engram.
  Existing connections keep working but every write now fails with an
  authorization error, loudly and immediately.

Option B — Atlas UI → Network Access → remove the IP entries.
  Connections drop. Blunter, and it also locks you out of the rollback
  until you re-add your IP, so prefer A.
```

Option A is better precisely because it fails *loudly*. A stray writer gets
`not authorized on engram to execute command insert` in its logs, which someone will
notice. A silently accepted write is the failure mode you are preventing.

Verify the revocation did what you think:

```sh
mongosh "$SOURCE_URI" --quiet --eval '
  try {
    db.getSiblingDB("engram").split_brain_probe.insertOne({at: new Date()});
    print("*** OLD CLUSTER STILL ACCEPTS WRITES — revocation did not take ***");
    db.getSiblingDB("engram").split_brain_probe.drop();
  } catch (e) { print("ok: old cluster rejected a write — " + e.codeName); }
'
```

> Run that probe with the **application** credential, not your admin one. Your admin
> user will still be able to write, and should be — that is what makes §8.4 possible.

### 12.5 Closing window 3 — the rollback week

For the seven days you keep the old cluster:

- [ ] The application user on the old cluster stays **read-only** (from §12.4)
- [ ] Your admin credential on the old cluster is **not** in any `.env`, any deployment
      config, or any teammate's hands
- [ ] The old cluster is **paused** if it is on the same credit allowance (§11.5) —
      a paused cluster cannot be written to at all, which is the strongest possible
      close
- [ ] The rollback procedure in §8.2 includes "restore the application user's
      `readWrite` role" as its first step, because you will have forgotten

If you do roll back, the sequence is: restore the role → change `.env` → restart.
Doing it in the other order gives you an application that starts and then fails every
write, which looks like a much worse problem than it is.

### 12.6 Detecting a split brain after the fact

If you suspect a stray write landed on the old cluster after the dump:

```sh
FREEZE=$(cat migration-freeze-time.txt)
mongosh "$SOURCE_URI" --quiet --eval "
  const d = db.getSiblingDB('engram');
  const t = new Date('$FREEZE');
  [['episodes','recordedAt'],['sources','recordedAt'],['audit_events','at'],
   ['medication_responses','occurredAt'],['daily_logs','recordedAt'],
   ['mobile_sos','createdAt'],['conversation_turns','startedAt']].forEach(([n,f]) => {
    const q = {}; q[f] = {\$gte: t};
    const c = d.getCollection(n).countDocuments(q);
    if (c) print(\`${'$'}{n}: ${'$'}{c} document(s) written to the OLD cluster after the freeze\`);
  });
  print('scan complete');
"
```

Anything it finds has to be moved forward to the new cluster by hand, using the delta
export in §8.3 but in the opposite direction. Prevention is cheaper than this.

---

## 13. Additional breaking changes

These extend §7. They are the items specific to the *schema upgrade* half of the
migration rather than the cluster move.

### 13.1 Time-series query patterns differ from regular collections

**What changes:** Four collections (`memory_trace_ts`, `symptom_ts`, `physiology_ts`,
`engagement_ts`) are created with `timeseries` options. They are not ordinary
collections and the differences are not cosmetic:

| Constraint | Consequence in your code |
| --- | --- |
| **No unique indexes** | Idempotency cannot be an index. `db/ingest.js` `appendSeries()` already gates every append on a `ts_dedupe` insert. If you add a new time-series writer, it must use that gate |
| **No updates** | Nothing that may need correcting can live here. This is exactly why `recall_attempts` stayed a regular collection — it has an `applied` flag that gets flipped |
| **`metaField` is effectively immutable per bucket** | `symptomCode` cannot be renamed in place. A vocabulary change means a new code plus a mapping table |
| **Secondary indexes only on `timeField` / `metaField` subfields** | There is no index for "all points with value ≥ 3". Threshold scans must be bounded by a meta + time prefix first |
| **Cannot be converted** | A regular collection cannot become time-series later. `provision.js` creates them with the options at `createCollection` time; if one already exists as a regular collection, provisioning will not fix it |

**How to test the fix:**

```sh
mongosh "$TARGET_URI" --quiet --eval '
  const d = db.getSiblingDB("engram");
  ["memory_trace_ts","symptom_ts","physiology_ts","engagement_ts"].forEach(n => {
    const info = d.getCollectionInfos({name:n})[0];
    print(`${n.padEnd(18)} ${info?.options?.timeseries ? "TIME-SERIES ok  " + JSON.stringify(info.options.timeseries) : "*** NOT time-series — drop and re-provision ***"}`);
  });
'
```

If one came out as a regular collection, drop it and re-run `npm run schema:provision`.
It is safe to drop: nothing has written to it yet.

### 13.2 `featureCompatibilityVersion`

**What changes:** FCV gates which features the server will accept. On Atlas M10+ it
is managed by Atlas and `setFeatureCompatibilityVersion` is restricted — you cannot
set it and should not try.

**What could break:** if the new cluster is created on 8.0 but Atlas leaves FCV at a
lower value during an upgrade window, 8.0-only behaviour (`$rankFusion`) can be
rejected even though `db.version()` reports 8.0.

**How to check:**

```sh
mongosh "$TARGET_URI" --quiet --eval '
  const r = db.adminCommand({getParameter:1, featureCompatibilityVersion:1});
  print("version: " + db.version());
  print("FCV    : " + (r.featureCompatibilityVersion?.version ?? "restricted/unavailable"));
'
```

**Fix:** Create the cluster at 8.0 rather than upgrading into it, and do not change
the version during the migration. If FCV reads below 8.0 on a cluster reporting 8.0,
wait — Atlas completes the FCV bump after the version upgrade settles — and re-check
before relying on `$rankFusion`.

### 13.3 Consent, retention and deletion behaviour

**What changes:** the new schema introduces retention machinery the old cluster does
not have. None of it activates by itself, which is deliberate, but it changes what
your code is responsible for.

| Mechanism | Before | After | What you must do |
| --- | --- | --- | --- |
| `consent_records` | did not exist | write-once, versioned, governs `proactiveContactAllowed` and `rehearsalAllowed` | **Create one per subject before cutover**, or procedures with a `consent_allows_proactive_contact` precondition will refuse to run and the companion will go silent |
| `dataRetention` | no policy | `{episodesDays, mediaDays, tsDays, auditDays}` on the consent record | Decide the numbers with whoever owns the clinical side. Nothing enforces them until you configure Online Archive |
| `deletion_requests` | no mechanism | an explicit erasure plan with per-collection modes | No code change now. When you act on one, §7.15 and §23.2 of the cluster document apply |
| Online Archive | none | not configured by this migration | Leave it off. When you enable it: archived data is **not searchable**, cannot be deleted per-document, and GridFS cannot be archived at all |

**The one that will bite you:** a missing consent record. Create one as part of D6:

```sh
mongosh "$TARGET_URI" --quiet --eval '
  const d = db.getSiblingDB("engram");
  const scope = { householdId: "demo-household", subjectId: "margaret" };
  if (!d.consent_records.countDocuments(scope)) {
    print("*** no consent record — proactive procedures will refuse to run ***");
    print("    seed one from db/examples/examples.json before the demo");
  } else print("consent record present");
'
```

`db/examples/examples.json` has a complete `consent_records` example to copy.

### 13.4 Write-once stores and the audit chain start

**What changes:** `audit_events` gains `seq`, `prevDigest` and `digest`. Events
written on the old cluster have none of these.

**What this means:** the hash chain starts at the migration point. `verify-audit.js`
handles this — it reports pre-chain events separately and does not treat their
absence as a break — but you should know that **events predating the migration are
not protected by the chain** and no amount of recomputation would honestly change
that. §16.1 step 10 of the schema document says the same thing.

**How to test:**

```sh
npm run schema:audit
```

Expect `N chained event(s) verified, M pre-chain`. A chain that starts at `seq` 1
immediately after migration is correct.
---

## 14. Embedding mode: the two options, with the index definitions

This decision must be made **before any vector index is created** (§0.2 step 7). It
determines the index definition, and an existing search index is never edited.

### 14.1 The two options

| | Automated Embedding | Manual embedding |
| --- | --- | --- |
| `EMBEDDING_MODE` | `auto` | `manual` |
| Index field type | `autoEmbed` on `searchText` | `vector` on `embedding` |
| Who computes the vector | Atlas, at index time | Your app, on write (`store.js` `prepareEpisode`) |
| Document carries a vector | No | Yes — `embedding: [1024 doubles]` |
| Needs a project integration | **Yes** | No |
| Needs `VOYAGE_API_KEY` | No | **Yes** |
| Existing episodes searchable | Immediately after the index builds | **Only after you re-embed them** |
| `$vectorSearch` query shape | `query: { text: "…" }` | `queryVector: [...]` |

`engram-retrieval/src/store.js` and `src/search.js` already branch on
`EMBEDDING_MODE`. **Neither option requires a code change** — only configuration and
the right index name.

### 14.2 Option A — enable Automated Embedding in the new project

Preferred, because existing episodes become searchable as soon as the index builds.

1. Atlas UI → the **new project** → **Integrations** (left nav, under Project Settings).
2. Find the **Voyage AI** / **Automated Embedding** integration and enable it for the
   project.
3. Confirm the model you need (`voyage-4`) is available to the project.
4. Leave `.env` as it is:

```dotenv
EMBEDDING_MODE=auto
VECTOR_INDEX=episodes_auto
SEARCH_INDEX=episodes_text
VOYAGE_DIMENSIONS=1024
VOYAGE_EMBED_MODEL=voyage-4
```

5. Run `npm run schema:provision`, then poll §D5 until `episodes_auto` is queryable.

**`episodes_auto` definition** (what `db/collections.js` sends; also the JSON to paste
in the Atlas UI if you create it by hand):

```json
{
  "name": "episodes_auto",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      { "type": "autoEmbed", "modality": "text", "path": "searchText", "model": "voyage-4" },
      { "type": "filter", "path": "householdId" },
      { "type": "filter", "path": "subjectId" },
      { "type": "filter", "path": "reviewStatus" },
      { "type": "filter", "path": "isCurrent" },
      { "type": "filter", "path": "sensitivity" },
      { "type": "filter", "path": "eventStart" },
      { "type": "filter", "path": "personIds" },
      { "type": "filter", "path": "chapterId" },
      { "type": "filter", "path": "semanticRefs" }
    ]
  }
}
```

Every one of those filter fields is load-bearing. `$vectorSearch` can only pre-filter
on declared fields, and post-filtering can return nothing while approved episodes
exist — a false negative the companion voices as *"I don't have a memory of that"*.

### 14.3 Option B — manual embedding, with a new index name

Use this if the integration is unavailable, or if you want the vectors in your own
documents.

1. Update **both** `.env` files:

```dotenv
EMBEDDING_MODE=manual
VOYAGE_API_KEY=<your key>
VOYAGE_EMBED_MODEL=voyage-4
VOYAGE_DIMENSIONS=1024
VECTOR_INDEX=episodes_manual
```

> `VECTOR_INDEX` **must change**. See §14.5.

2. Run `npm run schema:provision`. `db/collections.js` branches on `EMBEDDING_MODE`
   and emits the `vector` field instead of `autoEmbed`.

**`episodes_manual` definition:**

```json
{
  "name": "episodes_manual",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      { "type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine" },
      { "type": "filter", "path": "householdId" },
      { "type": "filter", "path": "subjectId" },
      { "type": "filter", "path": "reviewStatus" },
      { "type": "filter", "path": "isCurrent" },
      { "type": "filter", "path": "sensitivity" },
      { "type": "filter", "path": "eventStart" },
      { "type": "filter", "path": "personIds" },
      { "type": "filter", "path": "chapterId" },
      { "type": "filter", "path": "semanticRefs" }
    ]
  }
}
```

3. **Re-embed the restored episodes.** This is the cost of Option B and it is easy to
   forget: migrated documents have no `embedding` field, so they are invisible to
   vector search until you backfill one.

```sh
mongosh "$MONGODB_URI_NEW" --quiet --eval '
  const d = db.getSiblingDB("engram");
  const total = d.episodes.countDocuments({ reviewStatus: "approved", isCurrent: true });
  const without = d.episodes.countDocuments({
    reviewStatus: "approved", isCurrent: true,
    $or: [{ embedding: null }, { embedding: { $exists: false } }] });
  print(`approved episodes: ${total}`);
  print(`without an embedding: ${without}`);
  if (without) print("*** these are invisible to vector search until re-embedded ***");
'
```

Until a re-embed job exists, vector recall covers only episodes written **after** the
switch. Text search (`episodes_text`) is unaffected, so hybrid retrieval degrades
rather than failing — which makes this easy to miss.

### 14.4 The visual index is manual either way

`episodes_visual` always uses `type: "vector"` on `visualEmbedding`, because images
cannot go through text autoEmbed. It is unaffected by `EMBEDDING_MODE`:

```json
{
  "name": "episodes_visual",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      { "type": "vector", "path": "visualEmbedding", "numDimensions": 1024,
        "similarity": "cosine", "quantization": "scalar" },
      { "type": "filter", "path": "householdId" },
      { "type": "filter", "path": "subjectId" },
      { "type": "filter", "path": "reviewStatus" },
      { "type": "filter", "path": "isCurrent" },
      { "type": "filter", "path": "sensitivity" },
      { "type": "filter", "path": "eventStart" },
      { "type": "filter", "path": "personIds" },
      { "type": "filter", "path": "chapterId" },
      { "type": "filter", "path": "semanticRefs" }
    ]
  }
}
```

### 14.5 The silent-broken case

> **Changing `EMBEDDING_MODE` while keeping the same `VECTOR_INDEX` name creates an
> index that exists, reports queryable, and returns nothing.**

The mechanics: `episodes_auto` is defined with `autoEmbed` on `searchText`. If you
switch to `manual` but leave `VECTOR_INDEX=episodes_auto`, then:

- `db/provision.js` sees an index named `episodes_auto` already present and **skips
  it** — it never edits an existing search index definition, by design.
- `search.js` now builds a `$vectorSearch` with `path: "embedding"` and a
  `queryVector`, against an index that indexes `searchText` with `autoEmbed`.
- The query does not error. It returns zero results, every time.
- `atlas:check` reports execution succeeded. An empty result proves execution, not
  retrieval quality.

Nothing in the stack reports a problem. The only symptom is the companion saying it
has no memory of things it has memories of.

**Detection:**

```sh
mongosh "$MONGODB_URI_NEW" --quiet --eval '
  const d = db.getSiblingDB("engram");
  const idx = d.episodes.aggregate([{$listSearchIndexes:{}}]).toArray()
    .find(i => i.name === "'"${VECTOR_INDEX:-episodes_auto}"'");
  if (!idx) { print("index not found"); quit(); }
  const def = idx.latestDefinition ?? idx.definition ?? {};
  const field = (def.fields ?? []).find(f => f.type === "autoEmbed" || f.type === "vector");
  print(`index ${idx.name}: field type ${field?.type}, path ${field?.path}`);
  print(`EMBEDDING_MODE should be: ${field?.type === "autoEmbed" ? "auto" : "manual"}`);
'
```

Compare that last line against `EMBEDDING_MODE` in your `.env`. If they disagree,
**create a new index under a new name** and point `VECTOR_INDEX` at it. Do not try to
edit the old one.

---

## 15. Atlas UI steps for your friend

Send this section verbatim. Every setting below has a reason recorded elsewhere in
this runbook; the wrong default on any of them costs either the demo or the credits.

### 15.1 Create the cluster

1. Atlas → **Create** → **Dedicated** (not Flex, not Free).
2. **Provider and region:** AWS, and the region closest to where the app runs.
   Keep it one region.
3. **Cluster Tier: M10.** Not M20, not M30 — see §11.1 for the arithmetic.
4. **MongoDB version: 8.0**, selected explicitly from the dropdown.
   **Do not leave it on "Latest Version With Auto Upgrades."** An auto-upgrade can
   move the cluster onto a release that does not support the features this schema
   depends on.
5. **Additional Settings:**
   - **Auto-scale cluster tier: OFF.** Both "up" and "down".
   - **Auto-scale storage: OFF**, or on with an alert — on a fixed credit allowance
     this is the fastest way to lose the budget overnight.
   - **Turn on Backup: ON.**
   - **Require Indexes for All Queries: OFF.** With it on, every query against the
     ten `mobile_*` collections fails the moment they are restored, because they have
     no indexes until `provision.js` runs.
6. **Name:** `engram-prod`.
7. Do **not** add Search Nodes. Coupled search is correct here (§11.2).
8. Do **not** configure Online Archive.

### 15.2 Grant access

1. **Project Access** → invite me as **Project Owner**
   (or **Project Data Access Admin** + **Project Cluster Manager**).
2. **Database Access** → **Add New Database User**, twice:

| Username | Authentication | Role |
| --- | --- | --- |
| `anchorcare_migrate` | Password | `readWriteAnyDatabase` + `dbAdminAnyDatabase` (or `atlasAdmin`) |
| `anchorcare_app` | Password | `readWrite` on database `engram` |

`mongorestore` needs `dbAdmin` to create collections, indexes and validators, which
is why the migration user is broader than the application user. The application user
is the one that goes in `.env`; the migration credential never should.

3. **Network Access** → **Add IP Address** → the IP I give you, with a **6-hour
   expiry** during the migration. **Not `0.0.0.0/0`**, not even temporarily.

### 15.3 Project settings

1. **Integrations** → enable **Voyage AI / Automated Embedding** for the project
   (§14.2). This does not come across with the data, and its absence is the failure
   most often mistaken for a lost migration.
2. Leave everything else at defaults.

### 15.4 What to send back

- The cluster's **connection string** (`mongodb+srv://…`), without a database path
- The **password** for `anchorcare_app`, over something other than chat
- Confirmation that **"Require Indexes for All Queries" is off**
- Confirmation of the **MongoDB version shown on the cluster card** — it must read
  8.0, not "Latest"
