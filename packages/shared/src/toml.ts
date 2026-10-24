/** A small TOML reader for the repository config files. */
export class TomlError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'TomlError';
  }
}

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

/**
 * Parse the TOML a settings file uses: tables and dotted table headers, dotted
 * and quoted keys, basic / literal / multi-line strings, booleans, integers,
 * floats, arrays (multi-line, trailing comma, comments inside) and inline
 * tables. NOT supported, and refused with an error rather than misread: arrays
 * of tables (`[[x]]`), dates and times.
 *
 * Written here rather than added as a dependency because these files are small
 * and the subset is the whole of what they use; `croner` is this package's only
 * runtime dependency and it earns its place by doing DST.
 */
export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  let pos = 0;
  let line = 1;
  /** Tables created by a `[header]`, which may not be opened twice. */
  const explicitTables = new Set<TomlTable>();
  /** Inline tables and values, which may not be extended. */
  const frozen = new Set<TomlTable>();

  const fail = (message: string): never => {
    throw new TomlError(message, line);
  };
  const peek = (offset = 0) => source[pos + offset];
  const startsWith = (s: string) => source.startsWith(s, pos);
  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[pos] === '\n') line++;
      pos++;
    }
  };

  const skipInlineSpace = () => {
    while (peek() === ' ' || peek() === '\t') advance();
  };
  const skipComment = () => {
    if (peek() === '#') while (pos < source.length && peek() !== '\n') advance();
  };
  /** Whitespace, newlines and comments — inside arrays. */
  const skipAllSpace = () => {
    for (;;) {
      skipInlineSpace();
      if (peek() === '#') skipComment();
      else if (peek() === '\n' || (peek() === '\r' && peek(1) === '\n')) advance(peek() === '\r' ? 2 : 1);
      else return;
    }
  };
  const expectLineEnd = () => {
    skipInlineSpace();
    skipComment();
    if (peek() === '\r' && peek(1) === '\n') advance(2);
    else if (peek() === '\n') advance();
    else if (pos < source.length) fail(`unexpected "${peek()}" after value`);
  };

  const parseEscape = (): string => {
    const c = peek();
    advance();
    switch (c) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case 'e':
        return '\x1b';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
      case 'U': {
        const len = c === 'u' ? 4 : 8;
        const hex = source.slice(pos, pos + len);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail('invalid unicode escape');
        advance(len);
        return String.fromCodePoint(parseInt(hex, 16));
      }
      default:
        return fail(`invalid escape "\\${c ?? ''}"`);
    }
  };

  const parseBasicString = (): string => {
    advance(); // "
    let out = '';
    for (;;) {
      const c = peek();
      if (c === undefined || c === '\n') fail('unterminated string');
      if (c === '"') {
        advance();
        return out;
      }
      if (c === '\\') {
        advance();
        out += parseEscape();
      } else {
        out += c;
        advance();
      }
    }
  };

  const parseLiteralString = (): string => {
    advance(); // '
    const end = source.indexOf("'", pos);
    const nl = source.indexOf('\n', pos);
    if (end === -1 || (nl !== -1 && nl < end)) fail('unterminated literal string');
    const out = source.slice(pos, end);
    advance(end - pos + 1);
    return out;
  };

  const parseMultilineBasic = (): string => {
    advance(3);
    if (peek() === '\n') advance();
    else if (peek() === '\r' && peek(1) === '\n') advance(2);
    let out = '';
    for (;;) {
      if (pos >= source.length) fail('unterminated multi-line string');
      if (startsWith('"""')) {
        // Up to two quotes may sit right before the closing delimiter.
        let extra = 0;
        while (source[pos + 3 + extra] === '"' && extra < 2) extra++;
        out += '"'.repeat(extra);
        advance(3 + extra);
        return out;
      }
      const c = peek();
      if (c === '\\') {
        // A line-ending backslash trims the newline and following whitespace.
        let k = pos + 1;
        while (source[k] === ' ' || source[k] === '\t') k++;
        if (source[k] === '\n' || (source[k] === '\r' && source[k + 1] === '\n')) {
          advance(k - pos);
          while (/[ \t\r\n]/.test(peek() ?? '')) advance();
          continue;
        }
        advance();
        out += parseEscape();
        continue;
      }
      out += c;
      advance();
    }
  };

  const parseMultilineLiteral = (): string => {
    advance(3);
    if (peek() === '\n') advance();
    else if (peek() === '\r' && peek(1) === '\n') advance(2);
    const end = source.indexOf("'''", pos);
    if (end === -1) fail('unterminated multi-line literal string');
    let extra = 0;
    while (source[end + 3 + extra] === "'" && extra < 2) extra++;
    const out = source.slice(pos, end + extra);
    advance(end + extra + 3 - pos);
    return out;
  };

  const parseKeySegment = (): string => {
    skipInlineSpace();
    if (peek() === '"') return parseBasicString();
    if (peek() === "'") return parseLiteralString();
    const start = pos;
    while (/[A-Za-z0-9_-]/.test(peek() ?? '')) advance();
    if (pos === start) fail(`expected a key, found "${peek() ?? 'end of file'}"`);
    return source.slice(start, pos);
  };

  const parseDottedKey = (): string[] => {
    const parts = [parseKeySegment()];
    skipInlineSpace();
    while (peek() === '.') {
      advance();
      parts.push(parseKeySegment());
      skipInlineSpace();
    }
    return parts;
  };

  const isTable = (v: TomlValue | undefined): v is TomlTable =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  /** Walk/create intermediate tables for a dotted key. */
  const descend = (table: TomlTable, parts: string[]): TomlTable => {
    let t = table;
    for (const part of parts) {
      const existing = t[part];
      if (existing === undefined) {
        const next: TomlTable = {};
        t[part] = next;
        t = next;
      } else if (isTable(existing) && !frozen.has(existing)) {
        t = existing;
      } else {
        fail(`key "${part}" is already defined as a value`);
      }
    }
    return t;
  };

  const assign = (table: TomlTable, key: string[], value: TomlValue) => {
    const parent = descend(table, key.slice(0, -1));
    const leaf = key[key.length - 1];
    if (Object.prototype.hasOwnProperty.call(parent, leaf)) fail(`duplicate key "${key.join('.')}"`);
    parent[leaf] = value;
  };

  const parseNumberOrBool = (): TomlValue => {
    const start = pos;
    while (pos < source.length && /[A-Za-z0-9_+\-.]/.test(peek())) advance();
    const raw = source.slice(start, pos);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return fail('dates and times are not supported');
    return fail(raw ? `invalid value "${raw}"` : `expected a value, found "${peek() ?? 'end of file'}"`);
  };

  const parseArray = (): TomlValue[] => {
    advance(); // [
    const out: TomlValue[] = [];
    for (;;) {
      skipAllSpace();
      if (peek() === ']') {
        advance();
        return out;
      }
      out.push(parseValue());
      skipAllSpace();
      if (peek() === ',') {
        advance();
        continue;
      }
      if (peek() === ']') {
        advance();
        return out;
      }
      fail('expected "," or "]" in array');
    }
  };

  const parseInlineTable = (): TomlTable => {
    advance(); // {
    const table: TomlTable = {};
    skipInlineSpace();
    if (peek() === '}') {
      advance();
      frozen.add(table);
      return table;
    }
    for (;;) {
      const key = parseDottedKey();
      skipInlineSpace();
      if (peek() !== '=') fail('expected "=" in inline table');
      advance();
      skipInlineSpace();
      assign(table, key, parseValue());
      skipInlineSpace();
      if (peek() === ',') {
        advance();
        skipInlineSpace();
        continue;
      }
      if (peek() === '}') {
        advance();
        frozen.add(table);
        return table;
      }
      fail('expected "," or "}" in inline table');
    }
  };

  function parseValue(): TomlValue {
    if (startsWith('"""')) return parseMultilineBasic();
    if (startsWith("'''")) return parseMultilineLiteral();
    const c = peek();
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    if (c === '[') return parseArray();
    if (c === '{') return parseInlineTable();
    return parseNumberOrBool();
  }

  while (pos < source.length) {
    skipInlineSpace();
    const c = peek();
    if (c === undefined) break;
    if (c === '#') {
      skipComment();
      continue;
    }
    if (c === '\n' || (c === '\r' && peek(1) === '\n')) {
      advance(c === '\r' ? 2 : 1);
      continue;
    }
    if (c === '[') {
      if (peek(1) === '[') fail('arrays of tables ([[...]]) are not supported');
      advance();
      const key = parseDottedKey();
      skipInlineSpace();
      if (peek() !== ']') fail('expected "]" to close table header');
      advance();
      const table = descend(root, key);
      if (explicitTables.has(table)) fail(`table [${key.join('.')}] is defined twice`);
      explicitTables.add(table);
      current = table;
      expectLineEnd();
      continue;
    }
    const key = parseDottedKey();
    skipInlineSpace();
    if (peek() !== '=') fail(`expected "=" after key "${key.join('.')}"`);
    advance();
    skipInlineSpace();
    const value = parseValue();
    assign(current, key, value);
    expectLineEnd();
  }
  return root;
}
