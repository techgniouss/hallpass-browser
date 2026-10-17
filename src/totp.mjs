import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(s) {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('invalid base32 character in TOTP secret');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// Accepts a bare base32 secret or an otpauth:// URI (as shown under most "can't scan the QR code?" links).
export function parseTotpInput(input) {
  const s = input.trim();
  if (s.startsWith('otpauth://')) {
    const u = new URL(s);
    if (u.hostname !== 'totp') throw new Error('only otpauth://totp URIs are supported');
    const secret = u.searchParams.get('secret');
    if (!secret) throw new Error('otpauth URI has no secret');
    return {
      secret: secret.toUpperCase().replace(/\s/g, ''),
      algorithm: (u.searchParams.get('algorithm') || 'SHA1').toUpperCase(),
      digits: Number(u.searchParams.get('digits') || 6),
      period: Number(u.searchParams.get('period') || 30),
    };
  }
  return { secret: s.toUpperCase().replace(/[\s-]/g, ''), algorithm: 'SHA1', digits: 6, period: 30 };
}

export function hotp(key, counter, digits = 6, algorithm = 'SHA1') {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algorithm.toLowerCase(), key).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totp(cfg, nowMs = Date.now()) {
  const key = base32Decode(cfg.secret);
  return hotp(key, Math.floor(nowMs / 1000 / cfg.period), cfg.digits, cfg.algorithm);
}

// Seconds until the current code rolls over.
export const secondsLeft = (cfg, nowMs = Date.now()) => cfg.period - (Math.floor(nowMs / 1000) % cfg.period);
