import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import argon2 from "argon2";

export function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

export async function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password, { type: argon2.argon2id });
  } catch {
    return false;
  }
}

export function createOpaqueToken(bytes = 48) {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function encodeBase32(buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let index = 0; index < bits.length; index += 5) {
    output += base32Alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  }
  return output;
}

function decodeBase32(value) {
  const clean = value.toUpperCase().replace(/=+$/, "");
  let bits = "";
  for (const character of clean) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

export function createMfaSecret() {
  return encodeBase32(randomBytes(20));
}

export function encryptMfaSecret(secret, encryptionKey) {
  const key = Buffer.from(encryptionKey, "hex");
  if (key.length !== 32) throw new Error("MFA_ENCRYPTION_KEY must be 64 hexadecimal characters");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

export function decryptMfaSecret(payload, encryptionKey) {
  const key = Buffer.from(encryptionKey, "hex");
  if (key.length !== 32 || !payload || payload.length < 29) throw new Error("Invalid MFA secret");
  const buffer = Buffer.from(payload);
  const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
}

function totpAt(secret, timestamp) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30_000)));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest.at(-1) & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return false;
  return [-1, 0, 1].some((window) => safeTokenEqual(totpAt(secret, now + window * 30_000), code));
}
