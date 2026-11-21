import { createRequire } from 'node:module';
import { Duplex } from 'node:stream';
import { PGlite } from './pglite.mjs';

const apiRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
const { Pool } = apiRequire('pg');

// Keep the actual node-postgres encoding and result parsers. The server lives inside this process.
// PGlite has one backend session, so the pool uses a single client and these checks run sequentially.
class MemoryPgStream extends Duplex {
  constructor(database) {
    super();
    this.database = database;
    this.started = false;
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  connect() { queueMicrotask(() => this.emit('connect')); return this; }
  _read() {}
  _write(chunk, _encoding, callback) { this.forward(chunk, callback); }
  _writev(chunks, callback) { this.forward(Buffer.concat(chunks.map(({ chunk }) => chunk)), callback); }
  forward(packet, callback) {
    if (!this.started) {
      this.started = true;
      this.push(Buffer.from('5200000008000000005a0000000549', 'hex'));
      callback();
      return;
    }
    if (packet[0] === 88) { this.push(null); callback(); return; }
    this.database.execProtocolRaw(packet, { syncToFs: false }).then((bytes) => {
      if (bytes.length) this.push(Buffer.from(bytes));
      callback();
    }, callback);
  }
}

export async function createIsolatedPool() {
  const database = new PGlite('memory://');
  await database.waitReady;
  const pool = new Pool({ user: 'postgres', database: 'postgres', host: 'unused.invalid',
    ssl: false, max: 1, idleTimeoutMillis: 0, connectionTimeoutMillis: 5_000,
    stream: () => new MemoryPgStream(database) });
  return { pool, close: async () => { await pool.end(); await database.close(); } };
}
