/**
 * Password hashing — scrypt-based with random salts.
 *
 * Format: `scrypt$<salt_hex>$<hash_hex>` (stored in auth_identities.password_hash)
 *
 * Why scrypt:
 *   scrypt is memory-hard, making GPU/ASIC attacks expensive. Node.js provides
 *   `crypto.scryptSync` natively — no native addon dependency. For V1 with a
 *   small user base, synchronous hashing is acceptable. If this becomes a
 *   bottleneck under load, switch to the async `crypto.scrypt()` variant.
 *
 * Timing-safe comparison:
 *   `verifyPassword` uses `crypto.timingSafeEqual` to prevent timing attacks
 *   that could leak information about which bytes of the hash matched.
 */

const crypto = require('crypto');

const KEY_LENGTH = 64;

function hashPassword(password) {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  if (!encoded || !encoded.startsWith('scrypt$')) {
    return false;
  }

  const [, salt, savedHash] = encoded.split('$');
  if (!salt || !savedHash) {
    return false;
  }

  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  const hashBuffer = Buffer.from(hash, 'hex');
  const savedBuffer = Buffer.from(savedHash, 'hex');

  if (hashBuffer.length !== savedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(hashBuffer, savedBuffer);
}

module.exports = {
  hashPassword,
  verifyPassword
};
