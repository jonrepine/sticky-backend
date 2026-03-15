/**
 * Shared serializers, data loaders, and domain helpers used across resolvers.
 *
 * Why this file exists:
 *   Multiple resolver files need to convert Sequelize/Mongoose rows into the
 *   camelCase shapes the GraphQL schema expects. Centralising serializers here
 *   guarantees that every resolver returns identical field names and date
 *   formats, and means a schema change only requires one edit.
 *
 * Key patterns:
 *   - `toIso()`  — null-safe date → ISO-8601 string (returns null on bad input)
 *   - `safeIso()`— same but falls back to "now" instead of null
 *   - `serialize*()` — pure transforms from DB row → GraphQL shape
 *   - `load*()` — fetch + serialise convenience wrappers
 *   - `findOrCreateTags()` — the single source of truth for the
 *     "find-by-slug, reactivate if soft-deleted, else create" pattern
 *   - `issueSessionTokens()` — JWT creation + session row insert
 *
 * Dual-database note:
 *   InfoBits and Cards live across PostgreSQL (metadata, status, scheduling)
 *   and MongoDB (rich content blocks). Serializers accept both a Sequelize
 *   instance and a Mongo lean document, merging them into one GraphQL type.
 */

const { Op } = require('sequelize');

function toIso(dateValue) {
  if (!dateValue) return null;

  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function safeIso(dateValue) {
  return toIso(dateValue) || new Date().toISOString();
}

// ── Serializers ─────────────────────────────────────────────

function serializeUser(user) {
  const created =
    user.created_at ??
    user.createdAt ??
    (typeof user.get === 'function' ? user.get('created_at') || user.get('createdAt') : null);

  const updated =
    user.updated_at ??
    user.updatedAt ??
    (typeof user.get === 'function' ? user.get('updated_at') || user.get('updatedAt') : null);

  return {
    userId: user.user_id,
    email: user.email,
    username: user.username,
    timezone: user.timezone,
    createdAt: safeIso(created),
    updatedAt: safeIso(updated)
  };
}

function serializeCategory(category) {
  return {
    categoryId: category.category_id,
    name: category.name,
    slug: category.slug,
    ownerType: category.owner_type,
    isActive: Boolean(category.is_active),
    doctrineVersion: category.doctrine_version || null,
    memoryArchetype: category.memory_archetype || null
  };
}

function serializeInfoBit({ infoBit, mongoDoc }) {
  const cards = (mongoDoc?.cards || []).map((card) => ({
    cardId: card.card_id,
    infoBitId: infoBit.info_bit_id,
    status: card.status,
    frontBlocks: card.front_blocks || [],
    backBlocks: card.back_blocks || [],
    createdAt: toIso(card.created_at),
    updatedAt: toIso(card.updated_at)
  }));

  return {
    infoBitId: infoBit.info_bit_id,
    title: infoBit.title,
    status: infoBit.status,
    category: serializeCategory(infoBit.category),
    tags: (infoBit.tags || []).map((tag) => tag.name),
    cards,
    dueAt: toIso(infoBit.due_at),
    noteSpec: infoBit.note_spec_json || null,
    createdAt: toIso(infoBit.created_at),
    updatedAt: toIso(infoBit.updated_at)
  };
}

// ── Data loaders ────────────────────────────────────────────

async function loadInfoBitsForUser({ models, mongoModels, userId }) {
  const infoBits = await models.InfoBit.findAll({
    where: {
      user_id: userId,
      status: 'active'
    },
    include: [
      { model: models.Category, as: 'category' },
      { model: models.Tag, as: 'tags', through: { attributes: [] } }
    ],
    order: [['created_at', 'DESC']]
  });

  const infoBitIds = infoBits.map((item) => item.info_bit_id);
  const mongoDocs = await mongoModels.InfoBitContent.find({
    _id: { $in: infoBitIds }
  }).lean();

  const mongoMap = new Map(mongoDocs.map((doc) => [doc._id, doc]));

  return infoBits.map((infoBit) =>
    serializeInfoBit({
      infoBit,
      mongoDoc: mongoMap.get(infoBit.info_bit_id)
    })
  );
}

async function loadSingleInfoBitForUser({ models, mongoModels, userId, infoBitId }) {
  const infoBit = await models.InfoBit.findOne({
    where: {
      info_bit_id: infoBitId,
      user_id: userId,
      status: { [Op.ne]: 'deleted' }
    },
    include: [
      { model: models.Category, as: 'category' },
      { model: models.Tag, as: 'tags', through: { attributes: [] } }
    ]
  });

  if (!infoBit) {
    throw new Error('InfoBit not found');
  }

  const mongoDoc = await mongoModels.InfoBitContent.findById(infoBitId).lean();

  return serializeInfoBit({ infoBit, mongoDoc });
}

// ── Tag normalization ───────────────────────────────────────

const { slugify } = require('../../shared/text/slugify');

function normalizeTagNames(rawTags) {
  const seen = new Set();
  const result = [];

  for (const raw of rawTags || []) {
    const name = String(raw || '').trim();
    if (!name) continue;

    const slug = slugify(name);
    if (!slug || seen.has(slug)) continue;

    seen.add(slug);
    result.push({ name, slug });
  }

  return result;
}

// ── Session token helper ────────────────────────────────────

const { randomUUID } = require('crypto');
const {
  hashToken,
  createAccessToken,
  createRefreshToken,
  getRefreshExpiryDate
} = require('../../shared/security/tokens');

async function issueSessionTokens({ models, user, deviceName, requestMeta, transaction }) {
  const sessionId = randomUUID();
  const accessToken = createAccessToken({ userId: user.user_id, sessionId });
  const refreshToken = createRefreshToken({ userId: user.user_id, sessionId });

  await models.Session.create(
    {
      session_id: sessionId,
      user_id: user.user_id,
      refresh_token_hash: hashToken(refreshToken),
      user_agent: requestMeta.userAgent,
      ip_address: requestMeta.ipAddress,
      device_name: deviceName || null,
      expires_at: getRefreshExpiryDate()
    },
    { transaction }
  );

  return {
    accessToken,
    refreshToken,
    user: serializeUser(user)
  };
}

function serializeTag(tag) {
  return {
    tagId: tag.tag_id,
    name: tag.name,
    slug: tag.slug,
    isActive: Boolean(tag.is_active),
    archivedAt: toIso(tag.archived_at)
  };
}

/**
 * Resolve an array of raw tag names into Sequelize Tag instances.
 *
 * For each tag: reuses an existing row (reactivating if soft-deleted/archived),
 * or creates a new one. This is the single source of truth for the
 * "find-or-create + reactivate" pattern so that createInfoBit, updateInfoBit,
 * and attachTags all behave identically.
 *
 * @param {Object}        opts
 * @param {Object}        opts.models       – Sequelize models
 * @param {string}        opts.userId       – owner
 * @param {Array<Object>} opts.normalizedTags – output of normalizeTagNames()
 * @param {Object|null}   opts.transaction  – optional Sequelize transaction
 * @returns {Promise<Array<Model>>} Sequelize Tag instances
 */
async function findOrCreateTags({ models, userId, normalizedTags, transaction }) {
  if (!normalizedTags || normalizedTags.length === 0) return [];

  const slugs = normalizedTags.map((t) => t.slug);
  const existing = await models.Tag.findAll({
    where: { user_id: userId, slug: { [Op.in]: slugs } },
    transaction,
    paranoid: false
  });
  const bySlug = new Map(existing.map((tag) => [tag.slug, tag]));
  const tagInstances = [];

  for (const tagInput of normalizedTags) {
    const existingTag = bySlug.get(tagInput.slug);
    if (existingTag) {
      if (existingTag.deleted_at || existingTag.archived_at || !existingTag.is_active) {
        await existingTag.update(
          { deleted_at: null, archived_at: null, is_active: true, name: tagInput.name },
          { transaction, paranoid: false }
        );
      }
      tagInstances.push(existingTag);
    } else {
      const created = await models.Tag.create(
        { tag_id: randomUUID(), user_id: userId, name: tagInput.name, slug: tagInput.slug, is_active: true },
        { transaction }
      );
      tagInstances.push(created);
    }
  }

  return tagInstances;
}

module.exports = {
  toIso,
  safeIso,
  serializeUser,
  serializeCategory,
  serializeInfoBit,
  serializeTag,
  loadInfoBitsForUser,
  loadSingleInfoBitForUser,
  normalizeTagNames,
  findOrCreateTags,
  issueSessionTokens
};
