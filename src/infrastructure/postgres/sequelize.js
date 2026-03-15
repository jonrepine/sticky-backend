const { Sequelize, Op } = require('sequelize');
const { randomUUID } = require('crypto');
const config = require('../../app/config');
const { initModels } = require('./models');

const sequelize = new Sequelize(config.postgresUrl, {
  dialect: 'postgres',
  logging: config.env === 'development' ? console.log : false,
  ...(config.env === 'production' && {
    dialectOptions: {
      ssl: { require: true, rejectUnauthorized: false }
    }
  })
});

const models = initModels(sequelize);

async function connectPostgres() {
  await sequelize.authenticate();
}

async function syncPostgresModels() {
  if (!config.db.syncOnStart) {
    return;
  }

  await sequelize.sync({ force: config.db.syncForce });
}

async function seedCoreData() {
  const defaultAlgorithm = {
    algorithm_key: 'fsrs',
    name: 'FSRS',
    version: 'ts-fsrs-v1',
    default_params: {
      request_retention: 0.9,
      maximum_interval: 36500,
      weights: [
        0.4, 0.6, 2.4, 5.8, 4.9, 0.9, 0.86, 0.01, 1.49, 0.14,
        0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61, 0.57, 0.25
      ]
    }
  };

  await models.Algorithm.upsert(defaultAlgorithm);

  const systemCategories = [
    { name: 'New Word', slug: 'new-word' },
    { name: 'New Word+', slug: 'new-word-plus' },
    { name: 'Technical Definition', slug: 'technical-definition' },
    { name: 'Fact', slug: 'fact' },
    { name: 'Joke', slug: 'joke' },
    { name: 'Virtue / Life Lesson', slug: 'virtue-life-lesson' },
    { name: 'Quote / Proverb / Verse', slug: 'quote-proverb-verse' },
    { name: 'Contrast Pair', slug: 'contrast-pair' },
    { name: 'Formula / Rule', slug: 'formula-rule' },
    { name: 'Procedure / Workflow', slug: 'procedure-workflow' }
  ];

  for (const category of systemCategories) {
    await models.Category.findOrCreate({
      where: {
        owner_type: 'system',
        owner_user_id: null,
        slug: category.slug
      },
      defaults: {
        name: category.name,
        is_active: true
      }
    });
  }
}

async function runCategoryMigration({ dryRun = true } = {}) {
  const systemCats = await models.Category.findAll({
    where: { owner_type: 'system', is_active: true }
  });
  const slugToId = new Map(systemCats.map((c) => [c.slug, c.category_id]));

  const candidates = await models.InfoBit.findAll({
    where: sequelize.where(
      sequelize.fn('jsonb_extract_path_text', sequelize.col('note_spec_json'), 'memoryArchetype'),
      { [Op.ne]: null }
    ),
    attributes: ['info_bit_id', 'user_id', 'category_id', 'note_spec_json']
  });

  const report = { wouldMigrate: 0, noActionNeeded: 0, noMappingAvailable: 0, breakdown: {} };

  for (const ib of candidates) {
    const archetype = ib.note_spec_json?.memoryArchetype;
    const targetCatId = slugToId.get(archetype);

    if (!targetCatId) {
      report.noMappingAvailable++;
      continue;
    }
    if (ib.category_id === targetCatId) {
      report.noActionNeeded++;
      continue;
    }

    report.wouldMigrate++;
    report.breakdown[archetype] = (report.breakdown[archetype] || 0) + 1;

    if (!dryRun) {
      const fromCatId = ib.category_id;
      await ib.update({ category_id: targetCatId });
      await models.ActivityEvent.create({
        activity_event_id: randomUUID(),
        user_id: ib.user_id,
        info_bit_id: ib.info_bit_id,
        event_type: 'infobit.category_migrated',
        payload: { from_category_id: fromCatId, to_category_id: targetCatId, source: 'memoryArchetype' },
        occurred_at: new Date()
      });
    }
  }

  return report;
}

module.exports = {
  sequelize,
  models,
  connectPostgres,
  syncPostgresModels,
  seedCoreData,
  runCategoryMigration
};
