/**
 * Card resolvers — add, update content, archive, delete (single + bulk).
 *
 * Ownership model:
 *   Cards don't have a direct `user_id`. Ownership is established by joining
 *   through the parent InfoBit (`card.info_bit_id → info_bit.user_id`).
 *   `findOwnedCard()` encapsulates this join so every mutation uses the same
 *   ownership check.
 *
 * Dual-write:
 *   Card metadata (status, timestamps, content_version) lives in PostgreSQL.
 *   Card *content* (front_blocks, back_blocks — rich JSON arrays) lives in
 *   MongoDB as nested documents inside the InfoBitContent document. Both are
 *   updated together; SQL transactions wrap the SQL writes, and Mongo updates
 *   happen within the same try/catch (rollback on failure).
 *
 * Content versioning:
 *   `content_version` on the SQL Card row is incremented on every content edit.
 *   This lets the frontend detect stale edits and enables future conflict
 *   resolution or edit history features.
 */

const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const { requireUser } = require('../../shared/auth/requireUser');
const { toIso } = require('./_helpers');

async function findOwnedCard(context, userId, cardId) {
  const card = await context.models.Card.findOne({
    where: { card_id: cardId },
    include: [{
      model: context.models.InfoBit,
      as: 'infoBit',
      where: { user_id: userId },
      attributes: ['info_bit_id', 'user_id']
    }],
    paranoid: false
  });
  return card;
}

function serializeCardFromMongo(mongoCard, infoBitId) {
  return {
    cardId: mongoCard.card_id,
    infoBitId,
    status: mongoCard.status,
    frontBlocks: mongoCard.front_blocks || [],
    backBlocks: mongoCard.back_blocks || [],
    createdAt: toIso(mongoCard.created_at),
    updatedAt: toIso(mongoCard.updated_at)
  };
}

const cardQueries = {};

const cardMutations = {
  addCard: async (_, { infoBitId, input }, context) => {
    const user = requireUser(context);

    const infoBit = await context.models.InfoBit.findOne({
      where: { info_bit_id: infoBitId, user_id: user.userId, status: { [Op.ne]: 'deleted' } }
    });
    if (!infoBit) throw new Error('InfoBit not found');

    const cardId = randomUUID();
    const now = new Date();

    const tx = await context.models.User.sequelize.transaction();
    try {
      await context.models.Card.create(
        { card_id: cardId, info_bit_id: infoBitId, status: 'active' },
        { transaction: tx }
      );

      const mongoCard = {
        card_id: cardId,
        front_blocks: input.frontBlocks || [],
        back_blocks: input.backBlocks || [],
        status: 'active',
        created_at: now,
        updated_at: now
      };

      await context.mongoModels.InfoBitContent.updateOne(
        { _id: infoBitId },
        { $push: { cards: mongoCard }, $inc: { number_of_cards: 1 }, $set: { updated_at: now } }
      );

      await tx.commit();
      return serializeCardFromMongo(mongoCard, infoBitId);
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  },

  updateCardContent: async (_, { input }, context) => {
    const user = requireUser(context);

    const card = await findOwnedCard(context, user.userId, input.cardId);
    if (!card) throw new Error('Card not found');

    const infoBitId = card.info_bit_id;
    const now = new Date();
    const mongoSet = { 'cards.$.updated_at': now };

    if (input.frontBlocks !== undefined) mongoSet['cards.$.front_blocks'] = input.frontBlocks;
    if (input.backBlocks !== undefined) mongoSet['cards.$.back_blocks'] = input.backBlocks;

    await context.mongoModels.InfoBitContent.updateOne(
      { _id: infoBitId, 'cards.card_id': input.cardId },
      { $set: mongoSet }
    );

    await card.update({ content_version: card.content_version + 1 });

    await context.models.ActivityEvent.create({
      activity_event_id: randomUUID(),
      user_id: user.userId,
      info_bit_id: infoBitId,
      card_id: input.cardId,
      event_type: 'card.content_updated',
      payload: { content_version: card.content_version },
      occurred_at: now
    });

    const mongoDoc = await context.mongoModels.InfoBitContent.findById(infoBitId).lean();
    const mongoCard = mongoDoc.cards.find((c) => c.card_id === input.cardId);
    return serializeCardFromMongo(mongoCard, infoBitId);
  },

  archiveCard: async (_, { cardId }, context) => {
    return transitionCard(context, cardId, 'archived', 'archived_at');
  },

  deleteCard: async (_, { cardId }, context) => {
    return transitionCard(context, cardId, 'deleted', 'deleted_at');
  },

  archiveCards: async (_, { cardIds }, context) => {
    const user = requireUser(context);
    const now = new Date();

    const cards = await context.models.Card.findAll({
      where: { card_id: { [Op.in]: cardIds }, status: 'active' },
      include: [{ model: context.models.InfoBit, as: 'infoBit', where: { user_id: user.userId }, attributes: ['info_bit_id'] }]
    });

    const ownedIds = cards.map((c) => c.card_id);
    const [affectedCount] = await context.models.Card.update(
      { status: 'archived', archived_at: now },
      { where: { card_id: { [Op.in]: ownedIds } }, paranoid: false }
    );

    for (const card of cards) {
      await context.mongoModels.InfoBitContent.updateOne(
        { _id: card.info_bit_id, 'cards.card_id': card.card_id },
        { $set: { 'cards.$.status': 'archived', 'cards.$.archived_at': now, 'cards.$.updated_at': now } }
      );
    }

    return { cardIds, affectedCount };
  },

  deleteCards: async (_, { cardIds }, context) => {
    const user = requireUser(context);
    const now = new Date();

    const cards = await context.models.Card.findAll({
      where: { card_id: { [Op.in]: cardIds }, status: { [Op.ne]: 'deleted' } },
      include: [{ model: context.models.InfoBit, as: 'infoBit', where: { user_id: user.userId }, attributes: ['info_bit_id'] }],
      paranoid: false
    });

    const ownedIds = cards.map((c) => c.card_id);
    const [affectedCount] = await context.models.Card.update(
      { status: 'deleted', deleted_at: now },
      { where: { card_id: { [Op.in]: ownedIds } }, paranoid: false }
    );

    for (const card of cards) {
      await context.mongoModels.InfoBitContent.updateOne(
        { _id: card.info_bit_id, 'cards.card_id': card.card_id },
        { $set: { 'cards.$.status': 'deleted', 'cards.$.deleted_at': now, 'cards.$.updated_at': now } }
      );
    }

    return { cardIds, affectedCount };
  }
};

async function transitionCard(context, cardId, newStatus, timestampField) {
  const user = requireUser(context);

  const card = await findOwnedCard(context, user.userId, cardId);
  if (!card) throw new Error('Card not found');

  const infoBitId = card.info_bit_id;
  const now = new Date();

  await card.update({ status: newStatus, [timestampField]: now }, { paranoid: false });

  await context.mongoModels.InfoBitContent.updateOne(
    { _id: infoBitId, 'cards.card_id': cardId },
    { $set: { 'cards.$.status': newStatus, [`cards.$.${timestampField}`]: now, 'cards.$.updated_at': now } }
  );

  const mongoDoc = await context.mongoModels.InfoBitContent.findById(infoBitId).lean();
  const mongoCard = mongoDoc.cards.find((c) => c.card_id === cardId);
  return serializeCardFromMongo(mongoCard, infoBitId);
}

module.exports = { cardQueries, cardMutations };
