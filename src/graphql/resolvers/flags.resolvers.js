/**
 * Flag resolvers — user-initiated quality markers on InfoBits, Cards, and Tags.
 *
 * Purpose:
 *   Flags let users mark content that needs attention (bad spelling, needs
 *   regeneration, missing media, low quality). The dashboard query surfaces
 *   flagged items so the user (or a future AI pipeline) can triage them.
 *
 * Entity polymorphism:
 *   A single `flags` table uses `entity_type` + `entity_id` to reference
 *   InfoBits, Cards, or Tags. The resolver validates ownership of the target
 *   entity before creating a flag. For Cards, `flagged_at` is also set on the
 *   card row for quick filtering without joining the flags table.
 *
 * Enum mapping:
 *   Same pattern as scheduling.resolvers — GraphQL SCREAMING_CASE ↔ DB snake_case
 *   via ENTITY_MAP/FLAG_MAP/STATUS_MAP and their reverse counterparts.
 */

const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const { requireUser } = require('../../shared/auth/requireUser');
const { toIso } = require('./_helpers');

const ENTITY_MAP = { INFOBIT: 'infobit', CARD: 'card', TAG: 'tag' };
const ENTITY_REVERSE = { infobit: 'INFOBIT', card: 'CARD', tag: 'TAG' };
const FLAG_MAP = { NEEDS_EDIT: 'needs_edit', NEEDS_REGENERATE: 'needs_regenerate', NEEDS_MEDIA: 'needs_media', LOW_QUALITY: 'low_quality', OTHER: 'other' };
const FLAG_REVERSE = { needs_edit: 'NEEDS_EDIT', needs_regenerate: 'NEEDS_REGENERATE', needs_media: 'NEEDS_MEDIA', low_quality: 'LOW_QUALITY', other: 'OTHER' };
const STATUS_MAP = { OPEN: 'open', RESOLVED: 'resolved' };
const STATUS_REVERSE = { open: 'OPEN', resolved: 'RESOLVED' };

function serializeFlag(f) {
  return {
    flagId: f.flag_id,
    entityType: ENTITY_REVERSE[f.entity_type],
    entityId: f.entity_id,
    flagType: FLAG_REVERSE[f.flag_type],
    note: f.note || null,
    status: STATUS_REVERSE[f.status],
    createdAt: toIso(f.created_at),
    resolvedAt: toIso(f.resolved_at)
  };
}

const flagQueries = {
  flags: async (_, { status, entityType }, context) => {
    const user = requireUser(context);

    const where = { user_id: user.userId };
    if (status) where.status = STATUS_MAP[status];
    if (entityType) where.entity_type = ENTITY_MAP[entityType];

    const flags = await context.models.Flag.findAll({
      where,
      order: [['created_at', 'DESC']]
    });

    return flags.map(serializeFlag);
  }
};

const flagMutations = {
  createFlag: async (_, { input }, context) => {
    const user = requireUser(context);
    const entityType = ENTITY_MAP[input.entityType];
    const flagType = FLAG_MAP[input.flagType];

    if (entityType === 'infobit') {
      const ib = await context.models.InfoBit.findOne({
        where: { info_bit_id: input.entityId, user_id: user.userId }
      });
      if (!ib) throw new Error('InfoBit not found');
    } else if (entityType === 'card') {
      const card = await context.models.Card.findOne({
        where: { card_id: input.entityId },
        include: [{ model: context.models.InfoBit, as: 'infoBit', where: { user_id: user.userId }, attributes: ['info_bit_id'] }],
        paranoid: false
      });
      if (!card) throw new Error('Card not found');
      await card.update({ flagged_at: new Date() }, { paranoid: false });
    } else if (entityType === 'tag') {
      const tag = await context.models.Tag.findOne({
        where: { tag_id: input.entityId, user_id: user.userId },
        paranoid: false
      });
      if (!tag) throw new Error('Tag not found');
    }

    const flag = await context.models.Flag.create({
      flag_id: randomUUID(),
      user_id: user.userId,
      entity_type: entityType,
      entity_id: input.entityId,
      flag_type: flagType,
      note: input.note || null,
      status: 'open'
    });

    await context.models.ActivityEvent.create({
      activity_event_id: randomUUID(),
      user_id: user.userId,
      event_type: 'flag.created',
      payload: { entity_type: entityType, entity_id: input.entityId, flag_type: flagType },
      occurred_at: new Date()
    });

    return serializeFlag(flag);
  },

  resolveFlag: async (_, { flagId }, context) => {
    const user = requireUser(context);

    const flag = await context.models.Flag.findOne({
      where: { flag_id: flagId, user_id: user.userId }
    });
    if (!flag) throw new Error('Flag not found');

    await flag.update({ status: 'resolved', resolved_at: new Date() });
    return serializeFlag(flag);
  }
};

module.exports = { flagQueries, flagMutations, serializeFlag };
