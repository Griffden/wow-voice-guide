'use strict';
// The small part of MessagePack that Fish Audio's streaming TTS socket speaks:
// maps, arrays, strings, binary, numbers, booleans and nil. Kept here so the
// companion needs no extra dependency.

function encode(value) {
  const parts = [];
  const byte = (...b) => parts.push(Buffer.from(b));
  const write = v => {
    if (v === null || v === undefined) return byte(0xc0);
    if (v === false) return byte(0xc2);
    if (v === true) return byte(0xc3);
    if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= 0 && v < 0x80) return byte(v);
      if (Number.isInteger(v) && v < 0 && v >= -32) return byte(0xe0 | (v + 32));
      if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) {
        if (v <= 0xff) return byte(0xcc, v);
        if (v <= 0xffff) return byte(0xcd, v >> 8, v & 0xff);
        const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(v, 1); return parts.push(b);
      }
      if (Number.isInteger(v) && v < 0 && v >= -0x80000000) { const b = Buffer.alloc(5); b[0] = 0xd2; b.writeInt32BE(v, 1); return parts.push(b); }
      const b = Buffer.alloc(9); b[0] = 0xcb; b.writeDoubleBE(v, 1); return parts.push(b);
    }
    if (typeof v === 'string') {
      const s = Buffer.from(v, 'utf8');
      if (s.length < 32) byte(0xa0 | s.length);
      else if (s.length <= 0xff) byte(0xd9, s.length);
      else if (s.length <= 0xffff) byte(0xda, s.length >> 8, s.length & 0xff);
      else { const b = Buffer.alloc(5); b[0] = 0xdb; b.writeUInt32BE(s.length, 1); parts.push(b); }
      return parts.push(s);
    }
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
      const s = Buffer.from(v);
      if (s.length <= 0xff) byte(0xc4, s.length);
      else if (s.length <= 0xffff) byte(0xc5, s.length >> 8, s.length & 0xff);
      else { const b = Buffer.alloc(5); b[0] = 0xc6; b.writeUInt32BE(s.length, 1); parts.push(b); }
      return parts.push(s);
    }
    if (Array.isArray(v)) {
      if (v.length < 16) byte(0x90 | v.length);
      else byte(0xdc, v.length >> 8, v.length & 0xff);
      return v.forEach(write);
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      if (entries.length < 16) byte(0x80 | entries.length);
      else byte(0xde, entries.length >> 8, entries.length & 0xff);
      for (const [k, x] of entries) { write(k); write(x); }
      return undefined;
    }
    throw new Error(`msgpack: cannot encode ${typeof v}`);
  };
  write(value);
  return Buffer.concat(parts);
}

function decode(buffer) {
  const b = Buffer.from(buffer);
  let i = 0;
  const need = n => { if (i + n > b.length) throw new Error('msgpack: truncated'); };
  const str = n => { need(n); const s = b.toString('utf8', i, i + n); i += n; return s; };
  const bin = n => { need(n); const s = b.subarray(i, i + n); i += n; return Buffer.from(s); };
  const arr = n => { const out = []; for (let k = 0; k < n; k++) out.push(read()); return out; };
  const map = n => { const out = {}; for (let k = 0; k < n; k++) { const key = read(); out[key] = read(); } return out; };
  const u = (n) => { need(n); const v = n === 1 ? b[i] : n === 2 ? b.readUInt16BE(i) : n === 4 ? b.readUInt32BE(i) : Number(b.readBigUInt64BE(i)); i += n; return v; };
  const s = (n) => { need(n); const v = n === 1 ? b.readInt8(i) : n === 2 ? b.readInt16BE(i) : n === 4 ? b.readInt32BE(i) : Number(b.readBigInt64BE(i)); i += n; return v; };
  const read = () => {
    need(1);
    const t = b[i++];
    if (t < 0x80) return t;
    if (t >= 0xe0) return t - 0x100;
    if ((t & 0xf0) === 0x80) return map(t & 0x0f);
    if ((t & 0xf0) === 0x90) return arr(t & 0x0f);
    if ((t & 0xe0) === 0xa0) return str(t & 0x1f);
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(u(1));
      case 0xc5: return bin(u(2));
      case 0xc6: return bin(u(4));
      case 0xca: { need(4); const v = b.readFloatBE(i); i += 4; return v; }
      case 0xcb: { need(8); const v = b.readDoubleBE(i); i += 8; return v; }
      case 0xcc: return u(1);
      case 0xcd: return u(2);
      case 0xce: return u(4);
      case 0xcf: return u(8);
      case 0xd0: return s(1);
      case 0xd1: return s(2);
      case 0xd2: return s(4);
      case 0xd3: return s(8);
      case 0xd9: return str(u(1));
      case 0xda: return str(u(2));
      case 0xdb: return str(u(4));
      case 0xdc: return arr(u(2));
      case 0xdd: return arr(u(4));
      case 0xde: return map(u(2));
      case 0xdf: return map(u(4));
      default: throw new Error(`msgpack: unsupported type 0x${t.toString(16)}`);
    }
  };
  return read();
}

module.exports = { encode, decode };
