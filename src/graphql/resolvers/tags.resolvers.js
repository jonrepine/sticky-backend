/**
 * Tag resolvers — listing, attaching/detaching from InfoBits, archiving, deleting.
 *
 * Why tags are a separate domain from InfoBits:
 *   Tags are user-scoped entities with their own lifecycle (archive, soft-delete)
 *   and can exist independently of any InfoBit. The many-to-many relationship
 *   (info_bit_tags join table) means tag operations affect multiple InfoBits.
 *
 * Mongo sync:
 *   When tags are attached/detached, the `tags` string array on the MongoDB
 *   InfoBitContent document is updated to stay in sync. This denormalisation
 *   exists so the frontend can display tag names without a separate SQL lookup.
 *
 * Soft-delete & reactivation:
 *   Tags use `is_active` + `archived_at` / `deleted_at` columns rather than
 *   hard deletes. When a user creates or attaches a tag whose slug already
 *   exists (even if archived/deleted), the existing row is reactivated via
 *   `findOrCreateTags()` in _helpers.js.
 */

const { Op } = require('sequelize');
const { requireUser } = require('../../shared/auth/requireUser');
const {
  normalizeTagNames,
  findOrCreateTags,
  serializeTag,
  loadSingleInfoBitForUser
} = require('./_helpers');

const tagQueries = {
  tags: async (_, __, context) => {
    const user = requireUser(context);

    const tags = await context.models.Tag.findAll({
      where: { user_id: user.userId, is_active: true },
      order: [['name', 'ASC']]
    });

    return tags.map(serializeTag);
  }
};

const tagMutations = {
  attachTags: async (_, { infoBitId, tags: rawTags }, context) => {
    const user = requireUser(context);

    const infoBit = await context.models.InfoBit.findOne({
      where: { info_bit_id: infoBitId, user_id: user.userId, status: { [Op.ne]: 'deleted' } }
    });
    if (!infoBit) throw new Error('InfoBit not found');

    const tags = normalizeTagNames(rawTags);
    if (tags.length === 0) throw new Error('No valid tags provided');

    const tx = await context.models.User.sequelize.transaction();

    try {
      const tagInstances = await findOrCreateTags({
        models: context.models,
        userId: user.userId,
        normalizedTags: tags,
        transaction: tx
      });
      await infoBit.addTags(tagInstances, { transaction: tx });

      const allTags = await infoBit.getTags({ transaction: tx });
      await context.mongoModels.InfoBitContent.updateOne(
        { _id: infoBitId },
        { $set: { tags: allTags.map((t) => t.name), updated_at: new Date() } }
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
      throw error;
    }
  },

  detachTags: async (_, { infoBitId, tagIds }, context) => {
    const user = requireUser(context);

    const infoBit = await context.models.InfoBit.findOne({
      where: { info_bit_id: infoBitId, user_id: user.userId, status: { [Op.ne]: 'deleted' } }
    });
    if (!infoBit) throw new Error('InfoBit not found');

    const tx = await context.models.User.sequelize.transaction();

    try {
      await context.models.InfoBitTag.destroy({
        where: { info_bit_id: infoBitId, tag_id: { [Op.in]: tagIds } },
        transaction: tx
      });

      const remainingTags = await infoBit.getTags({ transaction: tx });
      await context.mongoModels.InfoBitContent.updateOne(
        { _id: infoBitId },
        { $set: { tags: remainingTags.map((t) => t.name), updated_at: new Date() } }
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
      throw error;
    }
  },

  archiveTag: async (_, { tagId }, context) => {
    const user = requireUser(context);
    const tag = await context.models.Tag.findOne({
      where: { tag_id: tagId, user_id: user.userId }
    });
    if (!tag) throw new Error('Tag not found');

    await tag.update({ is_active: false, archived_at: new Date() });
    return serializeTag(tag);
  },

  deleteTag: async (_, { tagId }, context) => {
    const user = requireUser(context);
    const tag = await context.models.Tag.findOne({
      where: { tag_id: tagId, user_id: user.userId },
      paranoid: false
    });
    if (!tag) throw new Error('Tag not found');

    await tag.update({ is_active: false, deleted_at: new Date() }, { paranoid: false });
    return serializeTag(tag);
  },

  archiveTags: async (_, { tagIds }, context) => {
    const user = requireUser(context);
    const [affectedCount] = await context.models.Tag.update(
      { is_active: false, archived_at: new Date() },
      { where: { tag_id: { [Op.in]: tagIds }, user_id: user.userId, is_active: true } }
    );
    return { tagIds, affectedCount };
  },

  deleteTags: async (_, { tagIds }, context) => {
    const user = requireUser(context);
    const [affectedCount] = await context.models.Tag.update(
      { is_active: false, deleted_at: new Date() },
      { where: { tag_id: { [Op.in]: tagIds }, user_id: user.userId }, paranoid: false }
    );
    return { tagIds, affectedCount };
  }
};

module.exports = { tagQueries, tagMutations };
