/**
 * What goes wrong in the repository layer.
 *
 * Every error here is a programming mistake, not a bad request. They are
 * thrown when code asks the repository layer to do something that would break
 * tenant isolation, and the right response to one is a 500 and a page, not a
 * message for the caller.
 */

/**
 * A tenant-scoped repository was asked about a table it cannot scope.
 *
 * Either the table has no `organisation_id` column, or the name is not a
 * table this schema has. Both mean the call would have run without an
 * isolation predicate.
 */
export class TenantScopeError extends Error {
  override readonly name = 'TenantScopeError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * A write tried to put a row in, or move a row to, another organisation.
 *
 * Thrown when a caller passes an explicit `organisation_id` that is not the
 * one the repository is scoped to.
 */
export class CrossTenantWriteError extends Error {
  override readonly name = 'CrossTenantWriteError';

  /** The table the write was aimed at. */
  readonly table: string;

  /** The organisation the repository is pinned to. */
  readonly scopedTo: string;

  /** The organisation the write named instead. */
  readonly attempted: string;

  constructor(table: string, scopedTo: string, attempted: string) {
    super(
      `Refusing to write ${table} for organisation ${attempted}: ` +
        `this repository is scoped to ${scopedTo}.`,
    );
    this.table = table;
    this.scopedTo = scopedTo;
    this.attempted = attempted;
  }
}

/** A column or table name arrived that is not a plain SQL identifier. */
export class UnsafeIdentifierError extends Error {
  override readonly name = 'UnsafeIdentifierError';

  constructor(value: string) {
    super(
      `${JSON.stringify(value)} is not a valid identifier. ` +
        'Column and table names are never built from caller input.',
    );
  }
}
