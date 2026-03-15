/**
 * Auth resolvers — registration, login, logout, session refresh, profile update.
 *
 * Security model:
 *   - Passwords are hashed with scrypt (see shared/security/password.js).
 *   - Sessions use short-lived JWTs (access) + long-lived JWTs (refresh).
 *   - Refresh tokens are SHA-256 hashed before storage so a DB leak doesn't
 *     expose usable tokens.
 *   - `refreshSession` revokes the old session and issues a new one (token
 *     rotation). Reusing a revoked refresh token fails immediately.
 *
 * Why signIn doesn't use a transaction:
 *   The only write is `user.update({ last_login_at })` which is idempotent.
 *   Session creation via `issueSessionTokens` is a single INSERT that either
 *   succeeds or throws — no partial state to roll back.
 */

const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../app/config');
const { hashPassword, verifyPassword } = require('../../shared/security/password');
const { hashToken } = require('../../shared/security/tokens');
const { requireUser } = require('../../shared/auth/requireUser');
const { issueSessionTokens, serializeUser } = require('./_helpers');
const {
  detectIdentifierType,
  isValidUsernameShape,
  isValidEmailShape,
  USERNAME_MIN,
  USERNAME_MAX
} = require('../../shared/auth/signInIdentifier');

const MIN_PASSWORD_LEN = 8;

function normalizeUsername(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

const authQueries = {};

const authMutations = {
  signUp: async (_, { input }, context) => {
    const email = input.email.trim().toLowerCase();
    const usernameNorm = normalizeUsername(input.username);

    if (input.password.length < MIN_PASSWORD_LEN) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
    }
    if (usernameNorm.includes('@')) {
      throw new Error(`Username cannot contain @ (use 3–${USERNAME_MAX} chars: letters, digits, _ -)`);
    }
    if (!isValidUsernameShape(usernameNorm)) {
      throw new Error(
        `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters (letters, digits, underscore, hyphen only)`
      );
    }

    const existingEmail = await context.models.User.findOne({ where: { email } });
    if (existingEmail) {
      throw new Error('Email is already registered');
    }

    const existingUsername = await context.models.User.findOne({
      where: { username: usernameNorm }
    });
    if (existingUsername) {
      throw new Error('Username is already taken');
    }

    const tx = await context.models.User.sequelize.transaction();

    try {
      const user = await context.models.User.create(
        {
          user_id: randomUUID(),
          email,
          username: usernameNorm,
          timezone: input.timezone
        },
        { transaction: tx }
      );

      await context.models.AuthIdentity.create(
        {
          auth_identity_id: randomUUID(),
          user_id: user.user_id,
          provider: 'email_password',
          provider_subject: email,
          password_hash: hashPassword(input.password)
        },
        { transaction: tx }
      );

      const authPayload = await issueSessionTokens({
        models: context.models,
        user,
        deviceName: 'initial-session',
        requestMeta: context.requestMeta,
        transaction: tx
      });

      await context.models.ActivityEvent.create(
        {
          activity_event_id: randomUUID(),
          user_id: user.user_id,
          event_type: 'auth.signup',
          payload: { provider: 'email_password' },
          occurred_at: new Date()
        },
        { transaction: tx }
      );

      await tx.commit();
      return authPayload;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  },

  signIn: async (_, { input }, context) => {
    const raw = String(input.emailOrUsername || '').trim();
    if (!raw) {
      throw new Error('Invalid credentials');
    }

    let identity;
    if (detectIdentifierType(raw) === 'email') {
      if (!isValidEmailShape(raw)) {
        throw new Error('Invalid credentials');
      }
      const email = raw.toLowerCase();
      identity = await context.models.AuthIdentity.findOne({
        where: { provider: 'email_password', provider_subject: email }
      });
    } else {
      const usernameNorm = raw.toLowerCase();
      if (!isValidUsernameShape(usernameNorm)) {
        throw new Error('Invalid credentials');
      }
      const user = await context.models.User.findOne({
        where: { username: usernameNorm }
      });
      if (!user) {
        throw new Error('Invalid credentials');
      }
      identity = await context.models.AuthIdentity.findOne({
        where: { user_id: user.user_id, provider: 'email_password' }
      });
    }

    if (!identity || !identity.password_hash || !verifyPassword(input.password, identity.password_hash)) {
      throw new Error('Invalid credentials');
    }

    const user = await context.models.User.findByPk(identity.user_id);
    if (!user || !user.is_active) {
      throw new Error('Invalid credentials');
    }

    await user.update({
      last_login_at: new Date(),
      failed_login_attempts: 0
    });

    return issueSessionTokens({
      models: context.models,
      user,
      deviceName: input.deviceName || null,
      requestMeta: context.requestMeta,
      transaction: null
    });
  },

  signOut: async (_, __, context) => {
    const user = requireUser(context);

    const session = await context.models.Session.findByPk(user.sessionId);
    if (session && !session.revoked_at) {
      await session.update({ revoked_at: new Date() });
    }

    return true;
  },

  signOutAllSessions: async (_, __, context) => {
    const user = requireUser(context);

    await context.models.Session.update(
      { revoked_at: new Date() },
      { where: { user_id: user.userId, revoked_at: null } }
    );

    return true;
  },

  refreshSession: async (_, { refreshToken }, context) => {
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
    } catch {
      throw new Error('Invalid or expired refresh token');
    }

    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type');
    }

    const sessionId = decoded.sid;
    const userId = decoded.sub;

    const session = await context.models.Session.findByPk(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    if (session.revoked_at) {
      throw new Error('Session has been revoked');
    }

    if (new Date(session.expires_at) < new Date()) {
      throw new Error('Session has expired');
    }

    if (session.refresh_token_hash !== hashToken(refreshToken)) {
      throw new Error('Refresh token mismatch');
    }

    const user = await context.models.User.findByPk(userId);
    if (!user || !user.is_active) {
      throw new Error('User not available');
    }

    await session.update({ revoked_at: new Date() });

    return issueSessionTokens({
      models: context.models,
      user,
      deviceName: session.device_name,
      requestMeta: context.requestMeta,
      transaction: null
    });
  },

  updateMe: async (_, { input }, context) => {
    const user = requireUser(context);

    const dbUser = await context.models.User.findByPk(user.userId);
    if (!dbUser) {
      throw new Error('User not found');
    }

    const updates = {};
    if (input.username !== undefined) {
      const u = normalizeUsername(input.username);
      if (!u) {
        throw new Error(
          `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters (letters, digits, underscore, hyphen only)`
        );
      }
      if (u.includes('@') || !isValidUsernameShape(u)) {
        throw new Error(
          `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters (letters, digits, underscore, hyphen only)`
        );
      }
      const taken = await context.models.User.findOne({
        where: { username: u }
      });
      if (taken && taken.user_id !== user.userId) {
        throw new Error('Username is already taken');
      }
      updates.username = u;
    }
    if (input.timezone !== undefined) updates.timezone = input.timezone;

    if (Object.keys(updates).length > 0) {
      await dbUser.update(updates);
    }

    return serializeUser(dbUser);
  }
};

module.exports = { authQueries, authMutations };
