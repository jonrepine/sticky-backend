/**
 * Application configuration — single source of truth for environment variables.
 *
 * All env vars are read here and exported as a typed config object. Resolver
 * and infrastructure code should never read `process.env` directly — always
 * import from this module. This makes it easy to see what the app needs to run
 * and to mock config in tests.
 *
 * Required vars (will throw on startup if missing):
 *   JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, POSTGRES_URL, MONGODB_URI
 *
 * Optional vars (with defaults):
 *   NODE_ENV (development), PORT (4000), JWT_ACCESS_EXPIRES_IN (15m),
 *   JWT_REFRESH_EXPIRES_IN (30d), DB_SYNC (false), DB_SYNC_FORCE (false)
 */

require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function asBool(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  return String(value).toLowerCase() === 'true';
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d'
  },
  postgresUrl: required('POSTGRES_URL'),
  mongodbUri: required('MONGODB_URI'),
  db: {
    syncOnStart: asBool(process.env.DB_SYNC, false),
    syncForce: asBool(process.env.DB_SYNC_FORCE, false)
  },
  featureFlags: {
    noteSpecValidator: asBool(process.env.ENABLE_NOTESPEC_VALIDATOR, false)
  }
};
