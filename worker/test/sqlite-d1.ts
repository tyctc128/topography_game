// 測試用：以 node:sqlite 模擬 Cloudflare D1 的介面
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { DB, Stmt } from '../src/db';

export function sqliteD1(): DB {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));

  const make = (sql: string, args: unknown[] = []): Stmt => ({
    bind: (...v: unknown[]) => make(sql, v),
    first: async <T>() => ((db.prepare(sql).get(...(args as never[])) as T) ?? null),
    all: async <T>() => ({ results: db.prepare(sql).all(...(args as never[])) as T[] }),
    run: async () => db.prepare(sql).run(...(args as never[])),
  });

  return {
    prepare: (sql) => make(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
