# Database

The PostgreSQL schema for the platform. `apps/api` is the only thing that
talks to it.

## Requirements

PostgreSQL 14 or newer. Nothing here installs an extension: `gen_random_uuid()`
has been built into PostgreSQL since version 13, and `plpgsql`, which the
`updated_at` trigger needs, is installed in a new database by default.

## Applying the migrations

There is no migration runner yet, because adding one means adding a
dependency. Until a ticket picks one, apply the files in order with `psql`:

```bash
createdb explorer
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0001_core_data_model.sql
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0002_auth_and_tenancy.sql
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0003_append_only_audit_log.sql
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0004_auditable_event_stream.sql
```

Every migration wraps itself in `BEGIN` and `COMMIT`, so a file that fails
part way through leaves the database exactly as it was.

## Writing a migration

- Name it `NNNN_short_description.sql`, with the number four digits.
- Wrap the whole file in one transaction.
- Never edit a file that has been applied anywhere. Write the next one.
- Give every table-level `CHECK` a name. An API that has to turn a constraint
  violation into a message for a teacher needs to know which rule broke, and
  `mission_node_check2` does not tell it.

## How the schema is laid out

| Group | Tables |
| ----- | ------ |
| Tenancy and accounts | `organisation`, `app_user`, `membership`, `subscription` |
| Signing in | `user_credential`, `auth_session`, `participant_device` |
| Authoring | `expedition`, `expedition_version`, `mission_type`, `mission_template` |
| Inside one revision | `mission_instance`, `mission_node`, `hint` |
| Running an expedition | `expedition_session`, `participant`, `team`, `team_member` |
| Playing a mission | `mission_attempt`, `submission` |
| Assets and rewards | `media_asset`, `badge`, `ar_asset`, `qr_marker`, `inventory_item` |
| Event streams | `score_event`, `progression_event`, `live_event`, `audit_log` |

### The definition document, and the copy of it

`expedition_version.definition` holds a whole Expedition Definition
(EXPD-002) as one JSONB document. That document is the source of truth. It is
self contained, so the engine can run an expedition from it without another
query.

`mission_instance`, `mission_node` and `hint` are a flat copy of the parts of
that document other rows have to point at. A mission attempt needs a real
foreign key to the mission it is an attempt of, and a string buried in a JSONB
document cannot be one. EXPD-017 writes the copy whenever it writes a version.

If the two ever disagree, the document wins.

The graph's edges have no table. They stay in the document, where the engine
already reads them, and the edges leaving one node are copied into
`mission_node.outgoing_edges` so the Studio can draw a node without loading
the whole document. Nothing at runtime points at an edge.

### Where JSONB is used, and why

JSONB is used in exactly two situations, and nowhere else.

1. **The shape belongs to somebody else.** `mission_instance.config` is the
   clearest case: a QR hunt keeps its codes there and a puzzle keeps its
   answers, and only the mission type knows which is right. The same goes for
   `submission.payload`, `mission_type.config_schema` and `badge.criteria`.
2. **The document is stored whole.** `expedition_version.definition`.

Everything a query filters, sorts or joins on is a real column. Ages, scores,
locations, times and statuses are not hidden inside JSONB.

### Tenancy

Every table an organisation owns carries `organisation_id`, even where it
could be reached by following a parent. It is there so that an isolation
check is one predicate on the table being read, rather than a join chain
somebody can forget. EXPD-004 and EXPD-005 use it.

`mission_type` and `mission_template` and `badge` are the exception: a NULL
`organisation_id` there means a platform-wide row every organisation can use.

`audit_log` also allows a NULL, but it means the opposite: an action that
belongs to the platform rather than to any organisation. Nothing widens a
read to include those, and `organisation_id = $org` excludes them by itself.

Four tables carry no `organisation_id` at all, and none of them should.
`organisation` is the tenant. `app_user` is a person, and a person is not
owned by a school — the same teacher can work for two, which is what
`membership` is for. `user_credential` is that person's password, and
`auth_session` is their sign-in, which exists before they have chosen an
organisation to act for.

`apps/api/src/db/tables.ts` holds the same list in TypeScript, and the
repository layer checks every statement against it. `findTableRegistryDrift`
compares the two, so a table a migration adds without listing it there is
caught rather than being noticed the first time somebody queries it.

### Signing in

`0002_auth_and_tenancy.sql` adds what auth needs, and nothing else.

`app_user.is_platform_admin` is the only grant in the schema that crosses the
tenant boundary. It is a column rather than a `membership` role because the
grant belongs to no organisation, so there is no organisation to hang it off.

`user_credential.password_hash` holds the whole verifier, its cost parameters
included, so the cost can be raised later without a migration and without
locking out anybody whose row still carries the old one.

`auth_session` stores only the SHA-256 of a refresh token, so reading the
table gives an attacker nothing they can present. `family_id` ties together
every rotation descending from one sign-in: refreshing marks the old row
`rotated` and adds a new one to the same family, and a rotated token
presented again means two holders, so the whole family is revoked.

`participant_device` is the same idea for a student's phone, which has no
account to sign in with. It is tenant scoped, like everything a participant
owns.

### Append-only tables

`score_event`, `progression_event`, `live_event` and `audit_log` are written
once and never changed. They have no `updated_at` column and no `updated_at`
trigger.

For three of the four that is now a rule the database keeps rather than a
habit. `0003_append_only_audit_log.sql` attaches three triggers to
`audit_log`, and `0004_auditable_event_stream.sql` attaches the same three to
`score_event` and `progression_event`, so the only statement any of them
accepts is an `INSERT`:

```
UPDATE audit_log SET action = 'something else';
ERROR:  audit_log is append-only: UPDATE is not allowed on it
HINT:  Correct a wrong entry by appending another entry that says so.
```

`DELETE` and `TRUNCATE` are refused the same way, and all three raise
SQLSTATE `X0006`. The triggers hold for every caller, the owner of the table
included, which a `REVOKE` would not.

There is now also a role to revoke from. `infra/sql/application-role.sql`
(EXPD-007) creates `explorer_api`, the role the API signs in as, and does not
grant it the `UPDATE` and `DELETE` the triggers would refuse — so the attempt
fails at the permission check, one step before the rule that is the real
guarantee.

That is also why `audit_log` has no foreign keys any more. 0001 gave
`organisation_id`, `actor_user_id` and `actor_participant_id` an
`ON DELETE SET NULL`, which is an `UPDATE` run by the database itself, so
deleting an organisation would have failed against the rule above. 0003 drops
all three and leaves the columns as plain uuids, for the reason `entity_id`
already was one: an entry about something that has been deleted is exactly the
entry somebody will want to read, and `actor_label` is there so that it still
names somebody afterwards.

0004 drops `score_event`'s foreign keys for the same reason, and all of them
this time: three were `ON DELETE CASCADE`, which is a `DELETE` run by the
database itself, so deleting a team would have failed against the rule above.
A team's result is disputed after the afternoon is over and sometimes after
the session has been tidied away, so a line outliving the rows it names is the
behaviour wanted rather than the price of one.

`live_event` is deliberately untouched. It is how a client that dropped a
connection catches up (EXPD-023) rather than a record anything is decided by,
and the ticket that owns it is the one to say whether it is held to this.

### The event stream

`score_event` and `progression_event` are one stream per team rather than two
tables (EXPD-014). Three columns on each say so:

| Column            | What it is                                              |
| ----------------- | ------------------------------------------------------- |
| `stream_sequence` | The line's place in its team's stream, from one, with no gaps, **across both tables**. |
| `previous_hash`   | The seal on the line before it. Sixty-four noughts for the first. |
| `hash`            | SHA-256 over this line and `previous_hash`.             |

Ordering by `occurred_at` would not do: two lines can share a millisecond, and
a submission queued offline (EXPD-048) is stamped an hour before the line that
follows it.

The next number and the seal to chain from live on `team`, in `stream_length`
and `stream_head_hash`, beside `total_score` and for the same reason — a cache
of the stream, so that writing one line does not mean reading the whole run
back. A writer takes the team row `FOR UPDATE`, reads them, seals, inserts and
writes them back, all in one transaction. That lock is what makes the
numbering hold when two phones submit at once, and
`apps/api/src/stream/team-stream.ts` refuses to write outside a transaction
for that reason.

The seal is worked out by `packages/engine/src/stream/` and by nothing else.
It is taken over the *engine's* event, which names a mission, a hint and a
scoring rule by the ids the definition document uses — so 0004 adds
`mission_instance_key` and `hint_key` beside the existing uuids, along with
`attempt_number` and the `limit_*` pair that 0001 had nowhere to put. Without
those, a row read back would not be the line that was sealed, and a line about
a mission since deleted could not be checked at all.

The keys are the record and the uuids are the join, so a line may carry a key
alone and never a uuid alone.

What this buys is the thing a team arguing about a total should be handed:
the lines, and a check anybody can run over them. Editing one is caught even
by somebody who can turn the triggers off, because every seal after the edited
line is taken over a line that no longer says what it said.

### Deletes

Inside one thing, a delete cascades: deleting a revision deletes its missions
and nodes, and deleting a run deletes its teams and participants.

Across things that hold history, it does not. A revision a team has played
cannot be deleted, because `expedition_session` points at it with `RESTRICT`.
The audit log keeps `entity_id` as a plain uuid with no foreign key at all,
because an entry about something that has been deleted is exactly the entry
somebody will want to read.
