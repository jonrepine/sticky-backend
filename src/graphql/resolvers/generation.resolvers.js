/**
 * Generation policy resolvers — per-user/category/InfoBit LLM generation config.
 *
 * Mirrors the scheduler policy architecture: a hierarchical override system
 * where more specific scopes beat less specific ones. This lets users set a
 * global generation style and then tweak it per category (e.g. more creative
 * for vocab, stricter for medical terms).
 *
 * Resolution hierarchy (highest priority first):
 *   1. InfoBit-level override  → rarely used, future-safe
 *   2. Category-level policy   → most common customisation
 *   3. User default policy     → applies to everything the user owns
 *   4. System default          → hardcoded fallback (no DB row needed)
 *
 * Validation:
 *   config_json is validated here (not at DB level) to keep the model generic
 *   and the rules easy to update without migrations.
 */

const { randomUUID } = require('crypto');
const { requireUser } = require('../../shared/auth/requireUser');
const { toIso } = require('./_helpers');

const SCOPE_MAP = { USER_DEFAULT: 'user_default', CATEGORY: 'category', INFOBIT: 'infobit' };
const SCOPE_REVERSE = { user_default: 'USER_DEFAULT', category: 'CATEGORY', infobit: 'INFOBIT' };

const SYSTEM_DEFAULT_CONFIG = {
  targetCardCount: 3,
  requiredCardStyles: ['direct_qa'],
  creativityLevel: 2,
  deviationAllowance: 1,
  sourcePreference: [],
  socraticModeDefault: false,
  maxSocraticRounds: 2,
  includeClozeCard: true,
  customInstructions: '',
  socraticStages: {
    round1: 'context_grounding',
    round2: 'structure_targeting',
    round3: 'disambiguation_optional'
  }
};

const NEW_WORD_PLUS_SYSTEM_CONFIG = {
  ...SYSTEM_DEFAULT_CONFIG,
  targetCardCount: 4,
  requiredCardStyles: ['direct_qa', 'cloze_contextual', 'example_usage'],
  includeClozeCard: true,
  socraticModeDefault: true,
  maxSocraticRounds: 2,
  customInstructions: 'First gather where the learner saw/heard this phrase and in what context. Then generate cards that test the same phrase meaning and context recall.'
};

const CATEGORY_SYSTEM_DEFAULTS = {
  'new-word-plus': NEW_WORD_PLUS_SYSTEM_CONFIG
};

const VALID_CARD_STYLES = [
  'direct_qa', 'cloze_contextual', 'reverse_qa', 'true_false',
  'example_usage', 'analogy', 'mnemonic', 'scenario'
];

const VALID_SOCRATIC_STAGES = [
  'context_grounding', 'structure_targeting', 'disambiguation_optional'
];

const SCALE_METADATA = {
  creativity: [
    { level: 1, label: 'Minimal', blurb: 'Stick closely to the source material', implication: 'Cards mirror the input almost verbatim' },
    { level: 2, label: 'Balanced', blurb: 'Moderate rephrasing while preserving meaning', implication: 'Cards rephrase but keep the same core facts' },
    { level: 3, label: 'Creative', blurb: 'Explore related angles and analogies', implication: 'Cards may include analogies, examples, and inferred connections' },
    { level: 4, label: 'Expansive', blurb: 'Freely generate related knowledge connections', implication: 'Cards can introduce related concepts the user did not explicitly provide' }
  ],
  strictness: [
    { level: 1, label: 'Anchor-locked', blurb: 'Cards must only test the exact input fact', implication: 'No deviation from the original statement' },
    { level: 2, label: 'Tight', blurb: 'Minor rephrasing allowed, same core meaning', implication: 'Synonyms and simple restructuring permitted' },
    { level: 3, label: 'Flexible', blurb: 'Related sub-facts and implications allowed', implication: 'Cards can test logical consequences of the fact' },
    { level: 4, label: 'Open', blurb: 'Broad exploration within the topic domain', implication: 'Cards may test adjacent knowledge the learner should know' }
  ]
};

function validateConfig(config) {
  if (typeof config !== 'object' || config === null) {
    throw new Error('config must be a JSON object');
  }
  if (config.targetCardCount !== undefined) {
    if (!Number.isInteger(config.targetCardCount) || config.targetCardCount < 1 || config.targetCardCount > 8) {
      throw new Error('targetCardCount must be an integer between 1 and 8');
    }
  }
  if (config.creativityLevel !== undefined) {
    if (!Number.isInteger(config.creativityLevel) || config.creativityLevel < 1 || config.creativityLevel > 4) {
      throw new Error('creativityLevel must be an integer between 1 and 4');
    }
  }
  if (config.deviationAllowance !== undefined) {
    if (!Number.isInteger(config.deviationAllowance) || config.deviationAllowance < 1 || config.deviationAllowance > 4) {
      throw new Error('deviationAllowance must be an integer between 1 and 4');
    }
  }
  if (config.maxSocraticRounds !== undefined) {
    if (!Number.isInteger(config.maxSocraticRounds) || config.maxSocraticRounds < 1 || config.maxSocraticRounds > 3) {
      throw new Error('maxSocraticRounds must be an integer between 1 and 3');
    }
  }
  if (config.requiredCardStyles !== undefined) {
    if (!Array.isArray(config.requiredCardStyles)) {
      throw new Error('requiredCardStyles must be an array');
    }
    for (const style of config.requiredCardStyles) {
      if (!VALID_CARD_STYLES.includes(style)) {
        throw new Error(`Invalid card style: ${style}. Valid: ${VALID_CARD_STYLES.join(', ')}`);
      }
    }
  }
  if (config.includeClozeCard !== undefined) {
    if (typeof config.includeClozeCard !== 'boolean') {
      throw new Error('includeClozeCard must be a boolean');
    }
  }
  if (config.customInstructions !== undefined) {
    if (typeof config.customInstructions !== 'string') {
      throw new Error('customInstructions must be a string');
    }
    if (config.customInstructions.trim().length > 4000) {
      throw new Error('customInstructions must be 4000 characters or fewer');
    }
    config.customInstructions = config.customInstructions.trim();
  }
  if (config.socraticStages !== undefined) {
    if (typeof config.socraticStages !== 'object' || config.socraticStages === null || Array.isArray(config.socraticStages)) {
      throw new Error('socraticStages must be a JSON object');
    }
    const allowedKeys = ['round1', 'round2', 'round3'];
    for (const [key, value] of Object.entries(config.socraticStages)) {
      if (!allowedKeys.includes(key)) {
        throw new Error(`Invalid socraticStages key: ${key}. Valid: ${allowedKeys.join(', ')}`);
      }
      if (!VALID_SOCRATIC_STAGES.includes(value)) {
        throw new Error(`Invalid socraticStages value for ${key}: ${value}. Valid: ${VALID_SOCRATIC_STAGES.join(', ')}`);
      }
    }
  }
}

function serializeGenerationPolicy(p) {
  return {
    policyId: p.policy_id,
    scope: SCOPE_REVERSE[p.scope],
    categoryId: p.category_id || null,
    infoBitId: p.info_bit_id || null,
    isActive: Boolean(p.is_active),
    config: p.config_json,
    updatedAt: toIso(p.updated_at)
  };
}

async function resolveEffectiveGenerationPolicy(context, userId, infoBitId) {
  const infoBit = await context.models.InfoBit.findByPk(infoBitId);
  if (!infoBit) throw new Error('InfoBit not found');

  const ibPolicy = await context.models.GenerationPolicy.findOne({
    where: { user_id: userId, scope: 'infobit', info_bit_id: infoBitId, is_active: true }
  });
  if (ibPolicy) {
    return { scope: 'INFOBIT', config: ibPolicy.config_json, sourcePolicyId: ibPolicy.policy_id };
  }

  const catPolicy = await context.models.GenerationPolicy.findOne({
    where: { user_id: userId, scope: 'category', category_id: infoBit.category_id, is_active: true }
  });
  if (catPolicy) {
    return { scope: 'CATEGORY', config: catPolicy.config_json, sourcePolicyId: catPolicy.policy_id };
  }

  const userPolicy = await context.models.GenerationPolicy.findOne({
    where: { user_id: userId, scope: 'user_default', is_active: true }
  });
  if (userPolicy) {
    return { scope: 'USER_DEFAULT', config: userPolicy.config_json, sourcePolicyId: userPolicy.policy_id };
  }

  const category = await context.models.Category.findByPk(infoBit.category_id);
  if (category && CATEGORY_SYSTEM_DEFAULTS[category.slug]) {
    return { scope: 'USER_DEFAULT', config: CATEGORY_SYSTEM_DEFAULTS[category.slug], sourcePolicyId: null };
  }

  return { scope: 'USER_DEFAULT', config: SYSTEM_DEFAULT_CONFIG, sourcePolicyId: null };
}

const generationQueries = {
  generationPolicyScaleMetadata: () => SCALE_METADATA,

  generationPolicyPreview: async (_, { infoBitId }, context) => {
    const user = requireUser(context);
    return resolveEffectiveGenerationPolicy(context, user.userId, infoBitId);
  },

  generationPolicyByCategory: async (_, { categoryId }, context) => {
    const user = requireUser(context);
    const policy = await context.models.GenerationPolicy.findOne({
      where: { user_id: user.userId, scope: 'category', category_id: categoryId, is_active: true }
    });
    return policy ? serializeGenerationPolicy(policy) : null;
  },

  myLearningPreferences: async (_, __, context) => {
    const user = requireUser(context);
    const prefs = await context.models.UserLearningPreferences.findByPk(user.userId);
    if (!prefs) {
      return {
        newSessionDefaultCategoryId: null,
        defaultSocraticEnabled: false,
        defaultTags: [],
        updatedAt: toIso(new Date())
      };
    }
    return {
      newSessionDefaultCategoryId: prefs.new_session_default_category_id || null,
      defaultSocraticEnabled: Boolean(prefs.default_socratic_enabled),
      defaultTags: prefs.default_tags_json || [],
      updatedAt: toIso(prefs.updated_at)
    };
  }
};

const generationMutations = {
  upsertGenerationPolicy: async (_, { input }, context) => {
    const user = requireUser(context);
    const scope = SCOPE_MAP[input.scope];
    if (!scope) throw new Error('Invalid scope');

    validateConfig(input.config);

    if (scope === 'category') {
      if (!input.categoryId) throw new Error('categoryId is required for CATEGORY scope');
      const cat = await context.models.Category.findByPk(input.categoryId);
      if (!cat || !cat.is_active) throw new Error('Category not found or not accessible');
    }
    if (scope === 'infobit') {
      if (!input.infoBitId) throw new Error('infoBitId is required for INFOBIT scope');
      const ib = await context.models.InfoBit.findOne({
        where: { info_bit_id: input.infoBitId, user_id: user.userId }
      });
      if (!ib) throw new Error('InfoBit not found');
    }

    const where = { user_id: user.userId, scope };
    if (scope === 'category') where.category_id = input.categoryId;
    if (scope === 'infobit') where.info_bit_id = input.infoBitId;

    let policy = await context.models.GenerationPolicy.findOne({ where, paranoid: false });

    if (policy) {
      await policy.update({
        config_json: input.config,
        is_active: true,
        deleted_at: null
      }, { paranoid: false });
    } else {
      policy = await context.models.GenerationPolicy.create({
        policy_id: randomUUID(),
        user_id: user.userId,
        scope,
        category_id: scope === 'category' ? input.categoryId : null,
        info_bit_id: scope === 'infobit' ? input.infoBitId : null,
        config_json: input.config,
        is_active: true
      });
    }

    return serializeGenerationPolicy(policy);
  },

  removeGenerationPolicy: async (_, { policyId }, context) => {
    const user = requireUser(context);
    const policy = await context.models.GenerationPolicy.findOne({
      where: { policy_id: policyId, user_id: user.userId }
    });
    if (!policy) throw new Error('Policy not found');
    await policy.update({ is_active: false, deleted_at: new Date() });
    return true;
  },

  updateLearningPreferences: async (_, { input }, context) => {
    const user = requireUser(context);

    if (input.newSessionDefaultCategoryId) {
      const { Op } = require('sequelize');
      const cat = await context.models.Category.findOne({
        where: {
          category_id: input.newSessionDefaultCategoryId,
          is_active: true,
          [Op.or]: [
            { owner_type: 'system' },
            { owner_type: 'user', owner_user_id: user.userId }
          ]
        }
      });
      if (!cat) throw new Error('Category not found or not accessible');
    }

    const updates = {};
    if (input.newSessionDefaultCategoryId !== undefined) {
      updates.new_session_default_category_id = input.newSessionDefaultCategoryId;
    }
    if (input.defaultSocraticEnabled !== undefined) {
      updates.default_socratic_enabled = input.defaultSocraticEnabled;
    }
    if (input.defaultTags !== undefined) {
      updates.default_tags_json = input.defaultTags;
    }

    let prefs = await context.models.UserLearningPreferences.findByPk(user.userId);
    if (prefs) {
      await prefs.update(updates);
    } else {
      prefs = await context.models.UserLearningPreferences.create({
        user_id: user.userId,
        new_session_default_category_id: updates.new_session_default_category_id || null,
        default_socratic_enabled: updates.default_socratic_enabled || false,
        default_tags_json: updates.default_tags_json || null
      });
    }

    return {
      newSessionDefaultCategoryId: prefs.new_session_default_category_id || null,
      defaultSocraticEnabled: Boolean(prefs.default_socratic_enabled),
      defaultTags: prefs.default_tags_json || [],
      updatedAt: toIso(prefs.updated_at)
    };
  }
};

module.exports = { generationQueries, generationMutations, resolveEffectiveGenerationPolicy, SYSTEM_DEFAULT_CONFIG, SCALE_METADATA };
