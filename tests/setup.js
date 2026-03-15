/**
 * Test setup — boots Apollo Server, Postgres, and Mongo once per test suite.
 *
 * Why real databases:
 *   We test against real Postgres + Mongo (not mocks) to catch issues like
 *   Sequelize query generation, Mongo operator behaviour, transaction semantics,
 *   and join/include edge cases that mocks would miss. The trade-off is speed
 *   (~3s total) vs. fidelity — acceptable for 128 tests.
 *
 * Lifecycle:
 *   init()     — connects DBs, force-syncs all SQL tables (drops + recreates),
 *                seeds system data (categories, algorithm), drops all Mongo
 *                collections, starts Apollo Server.
 *   teardown() — stops Apollo, closes DB connections.
 *
 * Helpers:
 *   gql(query, vars)         — execute a GraphQL op without auth
 *   gqlAuth(token, query, vars) — execute with a Bearer token
 *   createTestUser(overrides) — sign up a fresh user, return tokens + user
 *   getModels()              — access Sequelize + Mongoose models for assertions
 *
 * Usage:
 *   beforeAll(async () => { await require('./setup').init(); }, 30000);
 *   afterAll(async () => { await require('./setup').teardown(); });
 */

require('dotenv').config(); // loads .env from spaced-rep-api root

const { ApolloServer } = require('@apollo/server');
const typeDefs = require('../src/graphql/schema');
const resolvers = require('../src/graphql/resolvers');
const { createContextFactory } = require('../src/app/context');
const {
  sequelize,
  models,
  connectPostgres,
  syncPostgresModels,
  seedCoreData
} = require('../src/infrastructure/postgres/sequelize');
const { mongoose, connectMongo } = require('../src/infrastructure/mongo/mongoose');
const InfoBitContent = require('../src/infrastructure/mongo/models/infobitContent.model');

let server;
let contextFactory;
const mongoModels = { InfoBitContent };

async function init() {
  await Promise.all([connectPostgres(), connectMongo()]);

  // Force-sync: drop and recreate all tables for a clean state
  await sequelize.sync({ force: true });
  await seedCoreData();

  // Clean Mongo collections
  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const col of collections) {
    await mongoose.connection.db.dropCollection(col.name);
  }

  server = new ApolloServer({ typeDefs, resolvers });
  await server.start();

  contextFactory = createContextFactory({ models, mongoModels });
}

async function teardown() {
  if (server) {
    await server.stop();
  }
  await sequelize.close();
  await mongoose.disconnect();
}

function getServer() {
  return server;
}

function getModels() {
  return { models, mongoModels };
}

/**
 * Execute a GraphQL operation without auth.
 */
async function gql(query, variables = {}) {
  const response = await server.executeOperation(
    { query, variables },
    {
      contextValue: contextFactory({
        req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } }
      })
    }
  );

  // Apollo Server 4 returns { body: { kind, singleResult } }
  if (response.body.kind === 'single') {
    return response.body.singleResult;
  }
  return response.body;
}

/**
 * Execute a GraphQL operation with a Bearer token.
 */
async function gqlAuth(token, query, variables = {}) {
  const response = await server.executeOperation(
    { query, variables },
    {
      contextValue: contextFactory({
        req: {
          headers: { authorization: `Bearer ${token}` },
          socket: { remoteAddress: '127.0.0.1' }
        }
      })
    }
  );

  if (response.body.kind === 'single') {
    return response.body.singleResult;
  }
  return response.body;
}

/**
 * Helper: sign up a fresh user and return { accessToken, refreshToken, user }.
 */
async function createTestUser(overrides = {}) {
  const email = overrides.email || `test-${Date.now()}@example.com`;
  const result = await gql(
    `mutation ($input: SignUpInput!) {
      signUp(input: $input) {
        accessToken
        refreshToken
        user { userId email timezone username }
      }
    }`,
    {
      input: {
        email,
        password: overrides.password || 'Password123',
        timezone: overrides.timezone || 'America/New_York',
        username: overrides.username || null
      }
    }
  );

  if (result.errors) {
    throw new Error(`createTestUser failed: ${result.errors[0].message}`);
  }

  return result.data.signUp;
}

module.exports = {
  init,
  teardown,
  getServer,
  getModels,
  gql,
  gqlAuth,
  createTestUser
};
