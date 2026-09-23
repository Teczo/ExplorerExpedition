/**
 * The Redis wire protocol, RESP2 (EXPD-023).
 *
 * Hand-written, for the reason `http/validation.ts` gives for its checkers:
 * a Redis client is a dependency and no ticket has added one. The channel
 * needs five commands — `AUTH`, `PING`, `PUBLISH`, `SUBSCRIBE` and
 * `UNSUBSCRIBE` — and RESP2 is small enough that reading and writing it is
 * the smaller risk.
 *
 * https://redis.io/docs/latest/develop/reference/protocol-spec/
 */

/** A value Redis sent. An error reply is a `RespError`, not a thrown one. */
export type RespValue = string | number | null | RespError | readonly RespValue[];

/** An error reply (`-ERR …`). Kept as a value, because it is an answer. */
export class RespError {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

/** The largest reply the parser will hold. Nothing the channel reads is near it. */
const MAX_BULK_BYTES = 16 * 1024 * 1024;

/** Writes one command as an array of bulk strings, the way every client does. */
export function encodeCommand(args: readonly string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = Buffer.from(arg, 'utf8');
    parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

/** Thrown when what arrived is not RESP. The connection cannot be trusted after it. */
export class RespProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespProtocolError';
  }
}

/**
 * Reads replies out of a byte stream that arrives in pieces.
 *
 * A reply can be split across two reads, and one read can hold several
 * replies, so bytes are kept until a whole reply is there.
 */
export class RespParser {
  #buffer: Buffer = Buffer.alloc(0);

  /** Adds bytes, and returns every reply they complete, oldest first. */
  feed(chunk: Buffer): RespValue[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const values: RespValue[] = [];
    for (;;) {
      const read = this.#read(0);
      if (read === undefined) {
        break;
      }
      values.push(read.value);
      this.#buffer = this.#buffer.subarray(read.end);
    }
    return values;
  }

  /** One value starting at `offset`, or undefined when it has not all arrived. */
  #read(offset: number): { value: RespValue; end: number } | undefined {
    const line = this.#line(offset);
    if (line === undefined) {
      return undefined;
    }
    const { text, end } = line;
    const kind = text[0];
    const rest = text.slice(1);

    switch (kind) {
      case '+':
        return { value: rest, end };
      case '-':
        return { value: new RespError(rest), end };
      case ':':
        return { value: this.#number(rest), end };
      case '$': {
        const length = this.#number(rest);
        if (length === -1) {
          return { value: null, end };
        }
        if (length < 0 || length > MAX_BULK_BYTES) {
          throw new RespProtocolError(`bulk length ${length} is out of range`);
        }
        if (this.#buffer.length < end + length + 2) {
          return undefined;
        }
        const value = this.#buffer.toString('utf8', end, end + length);
        return { value, end: end + length + 2 };
      }
      case '*': {
        const count = this.#number(rest);
        if (count === -1) {
          return { value: null, end };
        }
        const items: RespValue[] = [];
        let at = end;
        for (let index = 0; index < count; index += 1) {
          const item = this.#read(at);
          if (item === undefined) {
            return undefined;
          }
          items.push(item.value);
          at = item.end;
        }
        return { value: items, end: at };
      }
      default:
        throw new RespProtocolError(`unknown reply type ${JSON.stringify(kind)}`);
    }
  }

  #line(offset: number): { text: string; end: number } | undefined {
    const index = this.#buffer.indexOf('\r\n', offset);
    if (index === -1) {
      return undefined;
    }
    return { text: this.#buffer.toString('utf8', offset, index), end: index + 2 };
  }

  #number(text: string): number {
    const value = Number(text);
    if (!Number.isInteger(value)) {
      throw new RespProtocolError(`${JSON.stringify(text)} is not a whole number`);
    }
    return value;
  }
}
