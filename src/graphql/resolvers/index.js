/**
 * Root resolver index — the single merge point for all GraphQL resolvers.
 *
 * Architecture:
 *   Each domain (auth, infobits, tags, cards, reviews, scheduling, flags,
 *   dashboard) owns its own resolver file exporting `{ <domain>Queries,
 *   <domain>Mutations }`. This file imports them all and spreads them into a
 *   single `resolvers` object that Apollo Server consumes.
 *
 * What lives here vs. in a domain file:
 *   - `health` — stateless probe, no domain logic
 *   - `me`     — single-row user lookup, no domain dependency
 *   - `categories` — read-only system data, shared across domains
 *   Everything else belongs in the appropriate domain file.
 *
 * Adding a new domain:
 *   1. Create `<domain>.resolvers.js` exporting `{ <domain>Queries, <domain>Mutations }`
 *   2. Import here and spread into Query / Mutation below
 *   3. Add corresponding SDL in `../schema/index.js`
 *
 * Custom scalars:
 *   `JSON` is defined here because it's a transport-level concern (arbitrary
 *   blobs for FSRS params, policy configs, etc.), not a domain concept.
 */

const { Op } = require('sequelize');
const config = require('../../app/config');
const { serializeUser, serializeCategory } = require('./_helpers');
const { authQueries, authMutations } = require('./auth.resolvers');
const { infoBitQueries, infoBitMutations } = require('./infobits.resolvers');
const { tagQueries, tagMutations } = require('./tags.resolvers');
const { cardQueries, cardMutations } = require('./cards.resolvers');
const { reviewQueries, reviewMutations } = require('./reviews.resolvers');
const { schedulingQueries, schedulingMutations } = require('./scheduling.resolvers');
const { flagQueries, flagMutations } = require('./flags.resolvers');
const { dashboardQueries } = require('./dashboard.resolvers');
const { generationQueries, generationMutations } = require('./generation.resolvers');
const { validatorQueries } = require('./validator.resolvers');
const { GraphQLScalarType, Kind } = require('graphql');

const resolvers = {
  Query: {
    // ── Cross-cutting ───────────────────────────────────────
    health: () => ({
      ok: true,
      service: 'spaced-rep-api',
      featureFlags: config.env === 'production' ? null : config.featureFlags
    }),

    me: async (_, __, context) => {
      if (!context.user?.userId) {
        return null;
      }

      const user = await context.models.User.findByPk(context.user.userId);
      return user ? serializeUser(user) : null;
    },

    categories: async (_, __, context) => {
      const where = { is_active: true };

      if (context.user?.userId) {
        where[Op.or] = [
          { owner_type: 'system' },
          { owner_type: 'user', owner_user_id: context.user.userId }
        ];
      } else {
        where.owner_type = 'system';
      }

      const categories = await context.models.Category.findAll({
        where,
        order: [['owner_type', 'ASC'], ['name', 'ASC']]
      });

      return categories.map(serializeCategory);
    },

    // ── Domain resolvers ────────────────────────────────────
    ...authQueries,
    ...infoBitQueries,
    ...tagQueries,
    ...cardQueries,
    ...reviewQueries,
    ...schedulingQueries,
    ...flagQueries,
    ...dashboardQueries,
    ...generationQueries,
    ...validatorQueries
  },

  Mutation: {
    ...authMutations,
    ...infoBitMutations,
    ...tagMutations,
    ...cardMutations,
    ...reviewMutations,
    ...schedulingMutations,
    ...flagMutations,
    ...generationMutations
  },

  JSON: new GraphQLScalarType({
    name: 'JSON',
    description: 'Arbitrary JSON value',
    serialize: (value) => value,
    parseValue: (value) => value,
    parseLiteral: (ast) => {
      if (ast.kind === Kind.STRING) return JSON.parse(ast.value);
      return null;
    }
  })
};

module.exports = resolvers;
