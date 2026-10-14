import { PGlite, types } from '@electric-sql/pglite';

/** Minimal pg.Pool look-alike over PGlite (in-browser PostgreSQL). One connection → commands are serialised. */
export class LitePool {
  private tail: Promise<void> = Promise.resolve();
  constructor(public db: PGlite) {}

  static async create(dataDir?: string, wasm?: { pgliteWasmModule?: WebAssembly.Module; initdbWasmModule?: WebAssembly.Module; fsBundle?: Blob }) {
    const db = new PGlite({
      dataDir,
      ...(wasm ?? {}),
      parsers: { [types.NUMERIC]: (v: string) => v, [types.INT8]: (v: string) => v, [types.DATE]: (v: string) => v },
    });
    await db.waitReady;
    return new LitePool(db);
  }

  async connect() {
    let release!: () => void;
    const prev = this.tail;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    const db = this.db;
    return {
      async query(text: string, params?: unknown[]) {
        text = text.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/g, ''); // gen_random_uuid() is core in PG13+
        if (params === undefined) {
          const rs = await db.exec(text);
          const last = rs[rs.length - 1] ?? { rows: [], affectedRows: 0 };
          return { rows: last.rows as any[], rowCount: last.rows.length || (last.affectedRows ?? 0) };
        }
        const r = await db.query(text, params as any[]);
        return { rows: r.rows as any[], rowCount: r.rows.length || (r.affectedRows ?? 0) };
      },
      release() { release(); },
    };
  }

  async query(text: string, params?: unknown[]) {
    const c = await this.connect();
    try { return await c.query(text, params); } finally { c.release(); }
  }
  async end() { await this.db.close(); }
}
