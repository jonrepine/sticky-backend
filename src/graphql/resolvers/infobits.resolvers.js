/**
 * InfoBit resolvers — CRUD, lifecycle transitions, and bulk operations.
 *
 * Domain ownership:
 *   This file owns everything about the InfoBit *entity itself*: creation,
 *   reading, updating metadata (title, category, tags), and status transitions
 *   (active → archived → deleted, active → mastered). Card-level operations
 *   live in cards.resolvers.js; review/scheduling in reviews.resolvers.js.
 *
 * Dual-write pattern:
 *   createInfoBit and updateInfoBit write to both PostgreSQL (metadata, status,
 *   relationships) and MongoDB (rich content blocks) inside a SQL transaction.
 *   If the SQL transaction fails after the Mongo write, the Mongo document is
 *   cleaned up in the catch block. This is the "SQL-authoritative" pattern
 *   described in V1_BACKEND_SPEC.md — SQL is the source of truth, Mongo is the
 *   content store.
 *
 * Status machine:
 *   VALID_STATUS_TRANSITIONS defines the allowed state graph. The generic
 *   `transitionInfoBitStatus()` handles the update + activity event for all
 *   transitions, keeping each mutation thin.
 *
 * Pagination:
 *   `infoBits` uses cursor-based pagination keyed on `created_at`. The cursor
 *   is a base64-encoded ISO timestamp. We fetch `limit + 1` rows and slice to
 *   detect whether a next page exists.
 */

const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const { requireUser } = require('../../shared/auth/requireUser');
const {
  normalizeTagNames,
  findOrCreateTags,
  loadSingleInfoBitForUser,
  serializeInfoBit
} = require('./_helpers');
const { buildInitialFsrsState } = require('../../infrastructure/fsrs/engine');

const VALID_DEEP_ATTRIBUTES = new Set([
  'SOURCE', 'CONTEXT', 'SIGNIFICANCE', 'USAGE',
  'DOMAIN', 'CONTRAST', 'OCCASION', 'APPLICATION'
]);

const VALID_EXACTNESS_MODES = new Set([
  'GIST', 'TERM_EXACT', 'PHRASE_EXACT', 'VERBATIM'
]);

function validateNoteSpec(noteSpec) {
  if (noteSpec === null || noteSpec === undefined) return;
  if (typeof noteSpec !== 'object' || Array.isArray(noteSpec)) {
    throw new Error('noteSpec must be a JSON object');
  }

  if (!noteSpec.coreAnswer || typeof noteSpec.coreAnswer !== 'string' || noteSpec.coreAnswer.trim() === '') {
    throw new Error('noteSpec.coreAnswer is required and must be non-empty');
  }

  if (!VALID_EXACTNESS_MODES.has(noteSpec.exactnessMode)) {
    throw new Error(`noteSpec.exactnessMode must be one of: ${[...VALID_EXACTNESS_MODES].join(', ')}`);
  }

  if (noteSpec.maxIndependentFactsPerNote === undefined || noteSpec.maxIndependentFactsPerNote < 1) {
    throw new Error('noteSpec.maxIndependentFactsPerNote must be >= 1');
  }

  if (!Array.isArray(noteSpec.selectedDeepAttributes)) {
    throw new Error('noteSpec.selectedDeepAttributes must be an array');
  }

  for (const attr of noteSpec.selectedDeepAttributes) {
    if (!VALID_DEEP_ATTRIBUTES.has(attr)) {
      throw new Error(`Invalid deep attribute: ${attr}. Must be one of: ${[...VALID_DEEP_ATTRIBUTES].join(', ')}`);
    }
  }

  if (noteSpec.selectedDeepAttributes.length > 0) {
    if (!noteSpec.deepAttributes || typeof noteSpec.deepAttributes !== 'object') {
      throw new Error('noteSpec.deepAttributes must be an object when selectedDeepAttributes is non-empty');
    }

    for (const attr of noteSpec.selectedDeepAttributes) {
      const value = noteSpec.deepAttributes[attr];
      if (!value || typeof value !== 'string' || value.trim() === '') {
        throw new Error(`noteSpec.deepAttributes.${attr} must be a non-empty string`);
      }
    }

    if (!noteSpec.frontReminderText || typeof noteSpec.frontReminderText !== 'string' || noteSpec.frontReminderText.trim() === '') {
      throw new Error('noteSpec.frontReminderText is required when selectedDeepAttributes is non-empty');
    }
  }
}

const VALID_STATUS_TRANSITIONS = {
  active: ['archived', 'deleted', 'mastered'],
  archived: ['active', 'deleted'],
  mastered: ['active', 'archived']
};

async function findOwnedInfoBit(context, userId, infoBitId) {
  const infoBit = await context.models.InfoBit.findOne({
    where: { info_bit_id: infoBitId, user_id: userId },
    include: [
      { model: context.models.Category, as: 'category' },
      { model: context.models.Tag, as: 'tags', through: { attributes: [] } }
    ],
    paranoid: false
  });
  return infoBit;
}

const infoBitQueries = {
  infoBits: async (_, { cursor, limit = 20, categoryId, status }, context) => {
    const user = requireUser(context);
    const where = { user_id: user.userId };

    where.status = status || 'active';

    if (categoryId) where.category_id = categoryId;

    if (cursor) {
      where.created_at = { [Op.lt]: new Date(Buffer.from(cursor, 'base64').toString()) };
    }

    const infoBits = await context.models.InfoBit.findAll({
      where,
      include: [
        { model: context.models.Category, as: 'category' },
        { model: context.models.Tag, as: 'tags', through: { attributes: [] } }
      ],
      order: [['created_at', 'DESC']],
      limit: limit + 1,
      paranoid: false
    });

    const hasMore = infoBits.length > limit;
    const slice = hasMore ? infoBits.slice(0, limit) : infoBits;

    const infoBitIds = slice.map((ib) => ib.info_bit_id);
    const mongoDocs = await context.mongoModels.InfoBitContent.find({ _id: { $in: infoBitIds } }).lean();
    const mongoMap = new Map(mongoDocs.map((doc) => [doc._id, doc]));

    const edges = slice.map((infoBit) =>
      serializeInfoBit({ infoBit, mongoDoc: mongoMap.get(infoBit.info_bit_id) })
    );

    let nextCursor = null;
    if (hasMore) {
      const lastCreated = slice[slice.length - 1].created_at;
      nextCursor = Buffer.from(new Date(lastCreated).toISOString()).toString('base64');
    }

    return { edges, nextCursor };
  },

  infoBit: async (_, { infoBitId }, context) => {
    const user = requireUser(context);
    const infoBit = await context.models.InfoBit.findOne({
      where: {
        info_bit_id: infoBitId,
        user_id: user.userId,
        status: { [Op.ne]: 'deleted' }
      },
      include: [
        { model: context.models.Category, as: 'category' },
        { model: context.models.Tag, as: 'tags', through: { attributes: [] } }
      ]
    });

    if (!infoBit) return null;

    const mongoDoc = await context.mongoModels.InfoBitContent.findById(infoBitId).lean();
    return serializeInfoBit({ infoBit, mongoDoc });
  }
};

const infoBitMutations = {
  createInfoBit: async (_, { input }, context) => {
    const user = requireUser(context);

    if (!input.cards || input.cards.length === 0) {
      throw new Error('At least one card is required');
    }

    const category = await context.models.Category.findOne({
      where: {
        category_id: input.categoryId,
        is_active: true,
        [Op.or]: [
          { owner_type: 'system' },
          { owner_type: 'user', owner_user_id: user.userId }
        ]
      }
    });

    if (!category) {
      throw new Error('Category not found or not accessible');
    }

    if (input.noteSpec !== undefined && input.noteSpec !== null) {
      validateNoteSpec(input.noteSpec);
    }

    const infoBitId = randomUUID();
    const tags = normalizeTagNames(input.tags);
    const now = new Date();
    const cardRows = input.cards.map(() => ({
      card_id: randomUUID(),
      info_bit_id: infoBitId,
      status: 'active'
    }));

    const tx = await context.models.User.sequelize.transaction();
    let mongoCreated = false;

    try {
      const infoBit = await context.models.InfoBit.create(
        {
          info_bit_id: infoBitId,
          user_id: user.userId,
          category_id: category.category_id,
          title: input.title,
          status: 'pending_content',
          note_spec_json: input.noteSpec || null
        },
        { transaction: tx }
      );

      await context.models.Card.bulkCreate(cardRows, { transaction: tx });

      if (tags.length > 0) {
        const tagInstances = await findOrCreateTags({
          models: context.models,
          userId: user.userId,
          normalizedTags: tags,
          transaction: tx
        });
        await infoBit.addTags(tagInstances, { transaction: tx });
      }

      const initialFsrs = buildInitialFsrsState(now);
      await context.models.FSRSCardState.create(
        {
          info_bit_id: infoBitId,
          algorithm_key: 'fsrs',
          ...initialFsrs
        },
        { transaction: tx }
      );

      await infoBit.update({ due_at: initialFsrs.due }, { transaction: tx });

      await context.mongoModels.InfoBitContent.create({
        _id: infoBitId,
        user_id: user.userId,
        title: input.title,
        original_content: input.originalContent || null,
        tags: tags.map((tag) => tag.name),
        cards: input.cards.map((card, index) => ({
          card_id: cardRows[index].card_id,
          front_blocks: card.frontBlocks || [],
          back_blocks: card.backBlocks || [],
          status: 'active',
          created_at: now,
          updated_at: now
        })),
        number_of_cards: input.cards.length,
        rotation: {
          last_presented_card_id: null,
          last_presented_at: null
        },
        version: 1,
        created_at: now,
        updated_at: now
      });
      mongoCreated = true;

      await infoBit.update(
        { status: 'active' },
        { transaction: tx }
      );

      await context.models.ActivityEvent.create(
        {
          activity_event_id: randomUUID(),
          user_id: user.userId,
          info_bit_id: infoBitId,
          event_type: 'infobit.created',
          payload: {
            card_count: input.cards.length,
            tag_count: tags.length
          },
          occurred_at: now
        },
        { transaction: tx }
      );

      await tx.commit();

      return loadSingleInfoBitForUser({
        models: context.models,
        mongoModels: context.mongoModels,
        userId: user.userId,
        infoBitId
      });
    } catch (error) {
      await tx.rollback();

      if (mongoCreated) {
        await context.mongoModels.InfoBitContent.deleteOne({ _id: infoBitId });
      }

      throw error;
    }
  },

  updateInfoBit: async (_, { input }, context) => {
    const user = requireUser(context);

    const infoBit = await findOwnedInfoBit(context, user.userId, input.infoBitId);
    if (!infoBit || infoBit.status === 'deleted') {
      throw new Error('InfoBit not found');
    }

    const tx = await context.models.User.sequelize.transaction();

    try {
      const sqlUpdates = {};
      const mongoUpdates = {};

      if (input.title !== undefined) {
        sqlUpdates.title = input.title;
        mongoUpdates.title = input.title;
      }

      if (input.categoryId !== undefined) {
        const category = await context.models.Category.findOne({
          where: {
            category_id: input.categoryId,
            is_active: true,
            [Op.or]: [
              { owner_type: 'system' },
              { owner_type: 'user', owner_user_id: user.userId }
            ]
          }
        });
        if (!category) throw new Error('Category not found or not accessible');
        sqlUpdates.category_id = input.categoryId;
      }

      if (Object.keys(sqlUpdates).length > 0) {
        await infoBit.update(sqlUpdates, { transaction: tx });
      }

      if (input.tags !== undefined) {
        const newTags = normalizeTagNames(input.tags);
        const tagInstances = await findOrCreateTags({
          models: context.models,
          userId: user.userId,
          normalizedTags: newTags,
          transaction: tx
        });
        await infoBit.setTags(tagInstances, { transaction: tx });
        mongoUpdates.tags = newTags.map((t) => t.name);
      }

      if (Object.keys(mongoUpdates).length > 0) {
        mongoUpdates.updated_at = new Date();
        await context.mongoModels.InfoBitContent.updateOne(
          { _id: input.infoBitId },
          { $set: mongoUpdates }
        );
      }

      await tx.commit();

      return loadSingleInfoBitForUser({
        models: context.models,
        mongoModels: context.mongoModels,
        userId: user.userId,
        infoBitId: input.infoBitId
      });
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  },

  archiveInfoBit: async (_, { infoBitId }, context) => {
    return transitionInfoBitStatus(context, infoBitId, 'archived', 'archived_at');
  },

  deleteInfoBit: async (_, { infoBitId }, context) => {
    return transitionInfoBitStatus(context, infoBitId, 'deleted', 'deleted_at');
  },

  markInfoBitMastered: async (_, { infoBitId }, context) => {
    return transitionInfoBitStatus(context, infoBitId, 'mastered', 'mastered_at');
  },

  archiveInfoBits: async (_, { infoBitIds }, context) => {
    const user = requireUser(context);
    const now = new Date();

    const [affectedCount] = await context.models.InfoBit.update(
      { status: 'archived', archived_at: now },
      { where: { info_bit_id: { [Op.in]: infoBitIds }, user_id: user.userId, status: 'active' }, paranoid: false }
    );

    return { infoBitIds, affectedCount };
  },

  deleteInfoBits: async (_, { infoBitIds }, context) => {
    const user = requireUser(context);
    const now = new Date();

    const [affectedCount] = await context.models.InfoBit.update(
      { status: 'deleted', deleted_at: now },
      { where: { info_bit_id: { [Op.in]: infoBitIds }, user_id: user.userId, status: { [Op.ne]: 'deleted' } }, paranoid: false }
    );

    return { infoBitIds, affectedCount };
  }
};

async function transitionInfoBitStatus(context, infoBitId, newStatus, timestampField) {
  const user = requireUser(context);

  const infoBit = await findOwnedInfoBit(context, user.userId, infoBitId);
  if (!infoBit) {
    throw new Error('InfoBit not found');
  }

  const allowed = VALID_STATUS_TRANSITIONS[infoBit.status];
  if (!allowed || !allowed.includes(newStatus)) {
    throw new Error(`Cannot transition from '${infoBit.status}' to '${newStatus}'`);
  }

  const now = new Date();
  const updates = { status: newStatus, [timestampField]: now };

  await infoBit.update(updates);

  await context.models.ActivityEvent.create({
    activity_event_id: randomUUID(),
    user_id: user.userId,
    info_bit_id: infoBitId,
    event_type: `infobit.${newStatus}`,
    payload: { previous_status: infoBit.previous('status') || infoBit.status },
    occurred_at: now
  });

  const mongoDoc = await context.mongoModels.InfoBitContent.findById(infoBitId).lean();
  return serializeInfoBit({ infoBit, mongoDoc });
}

module.exports = { infoBitQueries, infoBitMutations };
