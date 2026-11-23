import net from 'node:net';

/**
 * A minimal Postgres wire-protocol server for tests that need REAL postgres-js
 * (its pool queues, its transaction queue, its sockets) and not a scripted
 * stand-in. It speaks enough of protocol 3.0 for postgres-js 3.4: trust auth,
 * simple queries, and the extended protocol with named or unnamed statements.
 * Every statement answers with no rows. BEGIN, COMMIT and ROLLBACK move the
 * transaction status that ReadyForQuery reports.
 *
 * A test controls each statement through `onStatement`: answer it, hold it
 * until a promise settles, or stall it for good (no reply, as on a dead
 * pooler connection). A held or stalled statement also holds every later
 * message on that connection, as a real server does.
 */

export type TxStatus = 'I' | 'T' | 'E';

export interface FakeStatement {
  sql: string;
  /** Server-side connection number, from 1. */
  conn: number;
  /** The transaction status when the statement arrived. */
  status: TxStatus;
}

/** `stall`: never answer. A promise: answer when it settles. */
export type StatementPlan = 'stall' | Promise<unknown> | void;

export interface FakePgServer {
  port: number;
  url: string;
  statements: FakeStatement[];
  /** Sockets that are still open, by server connection number. */
  sockets: Map<number, net.Socket>;
  onStatement: (s: FakeStatement) => StatementPlan;
  close: () => Promise<void>;
}

const NUL = 0;

function msg(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}

function cstr(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([NUL])]);
}

function readCstr(buf: Buffer, at: number): [string, number] {
  const end = buf.indexOf(NUL, at);
  return [buf.toString('utf8', at, end), end + 1];
}

function commandTag(sql: string): string {
  const word = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  if (word === 'BEGIN' || word === 'COMMIT' || word === 'ROLLBACK') return word;
  if (word === 'SET') return 'SET';
  if (word === 'SAVEPOINT' || word === 'RELEASE') return word;
  return 'SELECT 0';
}

function nextStatus(sql: string, status: TxStatus): TxStatus {
  const s = sql.trim().toLowerCase();
  if (s.startsWith('begin')) return 'T';
  if (s.startsWith('commit')) return 'I';
  if (s.startsWith('rollback to')) return status === 'E' ? 'T' : status;
  if (s.startsWith('rollback')) return 'I';
  return status;
}

export async function startFakePgServer(): Promise<FakePgServer> {
  let nextConn = 1;
  const server: FakePgServer = {
    port: 0,
    url: '',
    statements: [],
    sockets: new Map(),
    onStatement: () => undefined,
    close: async () => {
      for (const s of server.sockets.values()) s.destroy();
      await new Promise<void>((r) => tcp.close(() => r()));
    },
  };

  const tcp = net.createServer((socket) => {
    const conn = nextConn++;
    server.sockets.set(conn, socket);
    socket.on('close', () => server.sockets.delete(conn));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    let started = false;
    let status: TxStatus = 'I';
    const named = new Map<string, { sql: string; params: number }>();
    let unnamed = { sql: '', params: 0 };
    let portal = { sql: '' };
    let out: Buffer[] = [];
    let chain: Promise<void> = Promise.resolve();
    let dead = false;
    socket.on('close', () => {
      dead = true;
    });

    const send = (b: Buffer) => out.push(b);
    const flushOut = () => {
      if (dead || out.length === 0) return;
      socket.write(Buffer.concat(out));
      out = [];
    };

    /** The SQL to answer as (`onStatement` may rewrite it), or null for no answer. */
    const statement = async (sql: string): Promise<string | null> => {
      const s: FakeStatement = { sql, conn, status };
      server.statements.push(s);
      const plan = server.onStatement(s);
      if (plan === 'stall') {
        await new Promise(() => {});
        return null;
      }
      if (plan) await plan.catch(() => {});
      return dead ? null : s.sql;
    };

    const handle = async (type: number, body: Buffer): Promise<void> => {
      switch (String.fromCharCode(type)) {
        case 'Q': {
          const [text] = readCstr(body, 0);
          const sql = await statement(text);
          if (sql === null) return;
          send(msg('C', cstr(commandTag(sql))));
          status = nextStatus(sql, status);
          send(msg('Z', Buffer.from(status)));
          flushOut();
          return;
        }
        case 'P': {
          const [name, afterName] = readCstr(body, 0);
          const [text, afterText] = readCstr(body, afterName);
          const params = body.readInt16BE(afterText);
          const sql = await statement(text);
          if (sql === null) return;
          if (name) named.set(name, { sql, params });
          else unnamed = { sql, params };
          send(msg('1'));
          return;
        }
        case 'D': {
          const [name] = readCstr(body, 1);
          const st = name ? named.get(name) : unnamed;
          const n = st?.params ?? 0;
          send(
            msg(
              't',
              Buffer.concat([
                Buffer.from([n >> 8, n & 0xff]),
                ...Array.from({ length: n }, () => int32(25)),
              ]),
            ),
          );
          send(msg('n'));
          return;
        }
        case 'B': {
          const [, afterPortal] = readCstr(body, 0);
          const [stName] = readCstr(body, afterPortal);
          const st = stName ? named.get(stName) : unnamed;
          portal = { sql: st?.sql ?? '' };
          send(msg('2'));
          return;
        }
        case 'E': {
          send(msg('C', cstr(commandTag(portal.sql))));
          status = nextStatus(portal.sql, status);
          return;
        }
        case 'S':
          send(msg('Z', Buffer.from(status)));
          flushOut();
          return;
        case 'H':
          flushOut();
          return;
        case 'C':
          send(msg('3'));
          return;
        case 'X':
          socket.end();
          return;
        default:
          return;
      }
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 8) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          const code = buf.readInt32BE(4);
          buf = buf.subarray(len);
          if (code === 80877103) {
            socket.write('N');
            continue;
          }
          if (code === 80877102) {
            socket.destroy();
            return;
          }
          started = true;
          socket.write(
            Buffer.concat([
              msg('R', int32(0)),
              msg('S', Buffer.concat([cstr('server_version'), cstr('16.0')])),
              msg('K', Buffer.concat([int32(conn), int32(conn)])),
              msg('Z', Buffer.from('I')),
            ]),
          );
          continue;
        }
        if (buf.length < 5) return;
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) return;
        const type = buf[0]!;
        const body = Buffer.from(buf.subarray(5, len + 1));
        buf = buf.subarray(len + 1);
        chain = chain.then(() => handle(type, body));
      }
    });
  });

  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
  server.port = (tcp.address() as net.AddressInfo).port;
  server.url = `postgres://test:test@127.0.0.1:${server.port}/test`;
  return server;
}
