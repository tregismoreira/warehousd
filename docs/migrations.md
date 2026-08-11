# Migrations

`warehousd apply` is additive. It creates tables and adds columns, and it never rewrites or drops one. That is what makes it safe to run on every boot — and it is why a change that needs a column rewritten has to be refused rather than guessed at.

This is about **your data**, not warehousd's own schema. The `app.*` tables are versioned separately and upgrade themselves; nothing here applies to them.

## What counts as a breaking change

Anything that cannot be expressed as "add a column":

| Change in `warehousd.yml`         | Why it breaks                                     |
| --------------------------------- | ------------------------------------------------- |
| a field's `type`                   | the column holds values of the old type           |
| removing a field                   | the column and everything in it is stranded       |
| renaming a field                   | reads as a removal plus an addition               |
| a vocabulary's `multiple`          | `text` and `text[]` are different columns         |
| moving `pk: true`                  | document identity changes underneath every row    |
| removing a collection              | the whole table is stranded                       |

Adding a field, adding a collection, changing a posture, renaming a label: none of these touch stored values, and all of them apply on their own.

## dev and live are not treated the same

`data_synth` is a function of `(config, seed)`. It is truncated and regenerated on every boot, and file collections are re-indexed from their source directory — so warehousd rebuilds a synth table in place and says nothing. Iterating on your config locally has no ceremony at all.

`data_live` is real content that exists nowhere else. A breaking change to a live table **that holds rows** is refused. An empty one is rebuilt like a synth table, because there is nothing there to lose.

## The flow

```bash
warehousd migrate plan                        # what would break, and how badly
warehousd migrate generate -n widen-amount    # writes migrations/0001-widen-amount.sql
$EDITOR migrations/0001-widen-amount.sql      # review, uncomment, adjust
warehousd apply                               # migration runs, then the config applies
```

`migrate generate` writes the statements that make the change legal, in the order Postgres needs them — the view dropped first, any generated search column with it. `apply` recreates both.

A lossless cast (`int → numeric`, `text → text[]`) is written ready to run. A lossy one (`text → numeric`, `timestamptz → date`) is commented out under a `-- REVIEW:` header. That is the whole point of the file: you decide.

Commit the migration. It ships in the deploy image and runs on the target before the config is applied.

## Renaming, which is the case worth knowing

A rename looks like a removal plus an addition, and the addition creates an empty column. Do this instead, and nothing is lost:

```sql
alter table data_live."orders" rename column "amount" to "total";
```

`migrate generate` offers this above the `drop column` for exactly this reason.

## What checks what

Three things happen, and only one of them is authoritative:

- **`warehousd deploy` pre-flight** compares against the config from your last deploy and fails if a breaking change has appeared with no new migration. It runs on your machine and usually cannot reach the target database — with `database.managed: true` there is no URL to reach it with — so it is an early warning, not a verdict.
- **The release command** applies the migrations and then re-derives the plan from the live schema. This is the verdict. A failure here aborts the release and the previous version keeps serving.
- **The ledger** (`app.collection_migrations`) records that a migration ran and a checksum of the file. It records no intent, and does not need to: the check is the schema itself, so a migration that claims to fix a type but does not will still stop the boot.

Editing a migration after it has been applied is refused rather than silently skipped. An applied migration is history; add a new one.
