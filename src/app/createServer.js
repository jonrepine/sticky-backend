const { ApolloServer } = require('@apollo/server');
const typeDefs = require('../graphql/schema');
const resolvers = require('../graphql/resolvers');
const { createContextFactory } = require('./context');
const {
  models,
  connectPostgres,
  syncPostgresModels,
  seedCoreData
} = require('../infrastructure/postgres/sequelize');
const { connectMongo } = require('../infrastructure/mongo/mongoose');
const InfoBitContent = require('../infrastructure/mongo/models/infobitContent.model');

/**
 * Initialise databases, create Apollo server, and return everything
 * tests (or the production entry point) need.
 *
 * Returns { server, contextFactory, models, mongoModels, url? }
 */
async function initApp() {
  await Promise.all([connectPostgres(), connectMongo()]);
  await syncPostgresModels();
  await seedCoreData();

  const mongoModels = { InfoBitContent };

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    csrfPrevention: false
  });

  const contextFactory = createContextFactory({
    models,
    mongoModels
  });

  return { server, contextFactory, models, mongoModels };
}

module.exports = { initApp };
