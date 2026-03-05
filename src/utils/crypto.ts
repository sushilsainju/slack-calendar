import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

/**
 * Validates that TOKEN_ENCRYPTION_KEY is set and is exactly 32 bytes (64 hex chars).
 * Call this at startup when the Postgres backend is active.
 */
export function validateEncryptionKey(): void {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'hex');
  if (key.length !== 32) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
      'Generate with: openssl rand -hex 32',
    );
  }
}

function getKey(): Buffer {
  return Buffer.from(process.env.TOKEN_ENCRYPTION_KEY!, 'hex');
}

export function encryptJson(obj: unknown): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = JSON.stringify(obj);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString('base64')).join(':');
}

export function decryptJson<T>(blob: string): T {
  const key = getKey();
  const parts = blob.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted blob format');
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'),
  ) as T;
}
