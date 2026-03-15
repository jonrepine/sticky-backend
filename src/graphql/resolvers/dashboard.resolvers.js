/**
 * Dashboard resolvers — aggregation queries that span multiple domains.
 *
 * The dashboard is a read-only composite view that pulls flagged items and
 * tag-grouped InfoBits into a single response for the frontend home screen.
 * It intentionally denormalises data to minimise round-trips from the client.
 *
 * Why it's separate from infobits/flags/tags resolvers:
 *   Each domain resolver owns its own CRUD. The dashboard *composes* across
 *   them, so it lives in its own file to avoid coupling domain files together.
 *   If the dashboard grows (e.g. "recently reviewed", "streak stats"), the
 *   additions stay contained here.
 */

const { Op } = require('sequelize');
const { requireUser } = require('../../shared/auth/requireUser');
const { serializeInfoBit, serializeTag, toIso } = require('./_helpers');

const dashboardQueries = {
  dashboardInfoBits: async (_, { limitPerTag = 25, tagLimit = 20 }, context) => {
    const user = requireUser(context);

    // ── Flagged InfoBits ──────────────────────────────────────
    const infoBitFlags = await context.models.Flag.findAll({
      where: { user_id: user.userId, entity_type: 'infobit', status: 'open' }
    });
    const flaggedIbIds = infoBitFlags.map((f) => f.entity_id);

    let flaggedInfoBits = [];
    if (flaggedIbIds.length > 0) {
      const ibs = await context.models.InfoBit.findAll({
        where: { info_bit_id: { [Op.in]: flaggedIbIds }, user_id: user.userId, status: 'active' },
        include: [
          { model: context.models.Category, as: 'category' },
          { model: context.models.Tag, as: 'tags', through: { attributes: [] } }
        ]
      });
      const mongoDocs = await context.mongoModels.InfoBitContent.find({ _id: { $in: flaggedIbIds } }).lean();
      const mongoMap = new Map(mongoDocs.map((d) => [d._id, d]));
      flaggedInfoBits = ibs.map((ib) => serializeInfoBit({ infoBit: ib, mongoDoc: mongoMap.get(ib.info_bit_id) }));
    }

    // ── Flagged Cards ─────────────────────────────────────────
    const cardFlags = await context.models.Flag.findAll({
      where: { user_id: user.userId, entity_type: 'card', status: 'open' }
    });
    const flaggedCardIds = cardFlags.map((f) => f.entity_id);

    let flaggedCards = [];
    if (flaggedCardIds.length > 0) {
      const cards = await context.models.Card.findAll({
        where: { card_id: { [Op.in]: flaggedCardIds } },
        include: [{ model: context.models.InfoBit, as: 'infoBit', where: { user_id: user.userId }, attributes: ['info_bit_id'] }],
        paranoid: false
      });
      const ibIds = [...new Set(cards.map((c) => c.info_bit_id))];
      const mongoDocs = await context.mongoModels.InfoBitContent.find({ _id: { $in: ibIds } }).lean();
      const mongoMap = new Map(mongoDocs.map((d) => [d._id, d]));

      flaggedCards = cards.map((card) => {
        const mongoDoc = mongoMap.get(card.info_bit_id);
        const mongoCard = mongoDoc?.cards?.find((c) => c.card_id === card.card_id);
        return {
          cardId: card.card_id,
          infoBitId: card.info_bit_id,
          status: card.status,
          frontBlocks: mongoCard?.front_blocks || [],
          backBlocks: mongoCard?.back_blocks || [],
          createdAt: toIso(card.created_at),
          updatedAt: toIso(card.updated_at)
        };
      });
    }

    // ── InfoBits grouped by tag ───────────────────────────────
    const userTags = await context.models.Tag.findAll({
      where: { user_id: user.userId, is_active: true },
      order: [['name', 'ASC']],
      limit: tagLimit
    });

    const sectionsByTag = [];
    for (const tag of userTags) {
      const ibs = await context.models.InfoBit.findAll({
        where: { user_id: user.userId, status: 'active' },
        include: [
          { model: context.models.Category, as: 'category' },
          { model: context.models.Tag, as: 'tags', through: { attributes: [] }, where: { tag_id: tag.tag_id }, required: true }
        ],
        limit: limitPerTag,
        order: [['created_at', 'DESC']]
      });

      if (ibs.length > 0) {
        const ibIds = ibs.map((ib) => ib.info_bit_id);
        const mongoDocs = await context.mongoModels.InfoBitContent.find({ _id: { $in: ibIds } }).lean();
        const mongoMap = new Map(mongoDocs.map((d) => [d._id, d]));

        sectionsByTag.push({
          tag: serializeTag(tag),
          infoBits: ibs.map((ib) => serializeInfoBit({ infoBit: ib, mongoDoc: mongoMap.get(ib.info_bit_id) }))
        });
      }
    }

    return { flaggedInfoBits, flaggedCards, sectionsByTag };
  }
};

module.exports = { dashboardQueries };
