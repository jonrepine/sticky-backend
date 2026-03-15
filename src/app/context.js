/**
 * GraphQL context factory — builds the per-request context object.
 *
 * Every resolver receives `context` as its third argument. This factory
 * attaches:
 *   - `user`        — { userId, sessionId } if a valid JWT was provided, else null.
 *                     Resolvers call `requireUser(context)` to enforce auth.
 *   - `models`      — Sequelize models (PostgreSQL)
 *   - `mongoModels` — Mongoose models (MongoDB)
 *   - `requestMeta` — { ipAddress, userAgent } for session tracking
 *
 * JWT verification happens here (not in middleware) so that unauthenticated
 * queries (health, categories) still work — `user` is simply null.
 */

const jwt = require('jsonwebtoken');
const config = require('./config');

function getRequestIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }

  return req?.socket?.remoteAddress || null;
}

function createContextFactory({ models, mongoModels }) {
  return function buildContext({ req }) {
    const authHeader = req?.headers?.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    let user = null;
    if (token) {
      try {
        const decoded = jwt.verify(token, config.jwt.accessSecret);
        user = {
          userId: decoded.sub,
          sessionId: decoded.sid || null
        };
      } catch (error) {
        user = null;
      }
    }

    return {
      user,
      models,
      mongoModels,
      requestMeta: {
        ipAddress: getRequestIp(req),
        userAgent: req?.headers?.['user-agent'] || null
      }
    };
  };
}

module.exports = {
  createContextFactory
};
