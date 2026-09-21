/**
 * The hole where the database driver goes.
 *
 * EXPD-004 builds the repository layer, but no driver has been added to the
 * repository yet — one is a dependency, and no ticket has been allowed to add
 * one. So the repository layer is written against this interface instead of
 * against a client, and `createApp` takes the connection from its caller.
 *
 * The shape is `pg`'s on purpose. When a ticket adds the driver, a `pg.Pool`
 * and a `pg.PoolClient` both satisfy `Queryable` as they are, with no adapter
 * in between.
 */

/**
 * One row as the driver hands it back.
 *
 * Any object. The repository layer never indexes a row by a computed name, so
 * there is no reason to make every row interface carry an index signature it
 * would not use.
 */
export type QueryResultRow = object;

/** What a query gives back. */
export interface QueryResult<TRow extends QueryResultRow> {
  readonly rows: TRow[];
  /** How many rows the statement read or changed. */
  readonly rowCount: number | null;
}

/**
 * Anything that can run a parameterised statement.
 *
 * A pool, a pooled client, or a client inside a transaction. The repository
 * layer does not care which, which is what lets a caller run several
 * repositories inside one transaction by handing them all the same client.
 */
export interface Queryable {
  query<TRow extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TRow>>;
}

/**
 * Runs `work` inside one transaction.
 *
 * Every repository the work touches has to be built on the `Queryable` this
 * hands it, or its statements run outside the transaction.
 */
export async function inTransaction<TResult>(
  db: Queryable,
  work: (tx: Queryable) => Promise<TResult>,
): Promise<TResult> {
  await db.query('BEGIN');
  try {
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
