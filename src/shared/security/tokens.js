/**
 * JWT and token utilities — creation, hashing, expiry calculation.
 *
 * Token types:
 *   - Access token  — short-lived (default 15m), contains `sub` (userId) and
 *                     `sid` (sessionId). Used for all authenticated API calls.
 *   - Refresh token — long-lived (default 30d), additionally contains
 *                     `type: 'refresh'`. Stored as a SHA-256 hash in the
 *                     sessions table. Used only to obtain new token pairs.
 *
 * Why hash refresh tokens:
 *   If the DB is compromised, raw refresh tokens could impersonate users.
 *   Storing only the hash means a leaked DB row is useless without the
 *   original token (which only the client possesses).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../app/config');

function parseDurationToMs(duration) {
  if (typeof duration !== 'string' || duration.length < 2) {
    return 30 * 24 * 60 * 60 * 1000;
  }

  const value = Number(duration.slice(0, -1));
  const unit = duration.slice(-1);

  if (!Number.isFinite(value) || value <= 0) {
    return 30 * 24 * 60 * 60 * 1000;
  }

  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;

  return 30 * 24 * 60 * 60 * 1000;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createAccessToken({ userId, sessionId }) {
  return jwt.sign(
    { sid: sessionId },
    config.jwt.accessSecret,
    {
      subject: userId,
      expiresIn: config.jwt.accessExpiresIn
    }
  );
}

function createRefreshToken({ userId, sessionId }) {
  return jwt.sign(
    { sid: sessionId, type: 'refresh' },
    config.jwt.refreshSecret,
    {
      subject: userId,
      expiresIn: config.jwt.refreshExpiresIn
    }
  );
}

function getRefreshExpiryDate() {
  return new Date(Date.now() + parseDurationToMs(config.jwt.refreshExpiresIn));
}

module.exports = {
  hashToken,
  createAccessToken,
  createRefreshToken,
  getRefreshExpiryDate
};
