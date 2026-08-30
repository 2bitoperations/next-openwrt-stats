import 'server-only';
import { drizzle } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';

export const db = drizzle('file:./drizzle/db/local.db');

// WAL + synchronous=NORMAL is the standard high-throughput SQLite
// combination (and still crash-safe together, unlike NORMAL without WAL).
// Without this, every individual auto-committed write statement fsyncs -
// with the metrics collector issuing dozens of writes per second, that was
// enough to block the whole server's single-threaded synchronous sqlite
// driver for multi-second stretches. Journal mode is stored in the DB file
// itself, so this is a no-op after the first connection, but cheap to
// re-assert every time in case the file is ever recreated.
await db.run(sql`PRAGMA journal_mode = WAL`);
await db.run(sql`PRAGMA synchronous = NORMAL`);
