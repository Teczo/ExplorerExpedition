/**
 * A database that answers from a script and remembers what it was asked
 * (EXPD-005).
 *
 * `FakeDatabase` runs statements against rows, which is what the repository
 * tests need. Some of the code under test writes its own SQL — the membership
 * join in `AccountRepository`, for one — and that SQL is beyond the small
 * grammar the in-memory store understands.
 *
 * For those, this fake does the other half of the job. It never interprets a
 * statement. It hands back rows a test lined up in advance, and it keeps every
 * statement it was given, so a test can assert what was asked rather than what
 * came back: that the organisation reached the statement as a bound value, and
 * that the text really did filter on it.
 */

import type { Queryable, QueryResult, QueryResultRow } from '../../src/db/queryable.ts';
import type { FakeRow, RecordedStatement } from './fake-database.ts';

/** Rows to answer with, and which statements to answer. */
interface ScriptedAnswer {
  readonly matches: (statement: RecordedStatement) => boolean;
  readonly rows: readonly FakeRow[];
}

/** Answers from a script, and records the questions. */
export class RecordingDatabase implements Queryable {
  readonly #statements: RecordedStatement[] = [];
  readonly #answers: ScriptedAnswer[] = [];

  /**
   * Answers any statement containing `fragment` with these rows.
   *
   * Later answers win over earlier ones, so a test can set a default and then
   * override it for one statement.
   */
  answer(fragment: string, rows: readonly FakeRow[]): this {
    this.#answers.push({
      matches: (statement) => statement.text.includes(fragment),
      rows,
    });
    return this;
  }

  /** Every statement that has been run, oldest first. */
  get statements(): readonly RecordedStatement[] {
    return this.#statements;
  }

  /**
   * The one statement whose text contains `fragment`.
   *
   * Throws when none or several match, because a test asserting about "the
   * membership query" should fail loudly if there turn out to be two of them.
   */
  statementContaining(fragment: string): RecordedStatement {
    const found = this.#statements.filter((statement) =>
      statement.text.includes(fragment),
    );
    if (found.length !== 1) {
      throw new Error(
        `Expected exactly one statement containing ${JSON.stringify(fragment)}, ` +
          `found ${found.length}:\n` +
          this.#statements.map((statement) => `  ${statement.text}`).join('\n'),
      );
    }
    return found[0] as RecordedStatement;
  }

  /** Forgets the recorded statements. The script stays. */
  forgetStatements(): void {
    this.#statements.length = 0;
  }

  async query<TRow extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<TRow>> {
    const statement: RecordedStatement = { text, values };
    this.#statements.push(statement);

    const answer = this.#answers.findLast((candidate) => candidate.matches(statement));
    const rows = (answer?.rows ?? []) as TRow[];
    return { rows: [...rows], rowCount: rows.length };
  }
}
