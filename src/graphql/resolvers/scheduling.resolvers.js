/**
 * Scheduler policy resolvers — per-user/category/InfoBit FSRS parameter overrides.
 *
 * Why scheduler policies exist:
 *   Different content types benefit from different retention targets. A medical
 *   student might want 0.95 retention for anatomy terms but 0.80 for trivia.
 *   Policies let users (and eventually admins) tune FSRS parameters at three
 *   granularity levels without touching global defaults.
 *
 * Policy resolution hierarchy (highest priority first):
 *   1. InfoBit-level policy  → applies to one specific InfoBit
 *   2. Category-level policy → applies to all InfoBits in a category
 *   3. User-default policy   → applies to everything the user owns
 *   4. System default        → `algorithms.default_params` row for 'fsrs'
 *
 * Recalculation:
 *   `recalculateSchedules` replays the full review history through the FSRS
 *   engine with the *current* effective policy params. This is used after a
 *   user changes their retention target and wants existing cards to reflect the
 *   new schedule. It's intentionally synchronous (runs in-request) since V1
 *   doesn't have a job queue; this will need to be async for large libraries.
 *
 * Enum mapping:
 *   GraphQL uses SCREAMING_CASE enums (USER_DEFAULT, CATEGORY, INFOBIT).
 *   The DB stores snake_case (user_default, category, infobit). The SCOPE_MAP
 *   and SCOPE_REVERSE objects handle bidirectional conversion.
 */

const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const { requireUser } = require('../../shared/auth/requireUser');
const { toIso } = require('./_helpers');
const { dbRowToFsrsCard, computeReview, buildInitialFsrsState } = require('../../infrastructure/fsrs/engine');

const SCOPE_MAP = { USER_DEFAULT: 'user_default', CATEGORY: 'category', INFOBIT: 'infobit' };
const SCOPE_REVERSE = { user_default: 'USER_DEFAULT', category: 'CATEGORY', infobit: 'INFOBIT' };
const APPLY_MAP = { FUTURE_ONLY: 'future_only', RECALCULATE_EXISTING: 'recalculate_existing' };
const APPLY_REVERSE = { future_only: 'FUTURE_ONLY', recalculate_existing: 'RECALCULATE_EXISTING' };
const RATING_REVERSE = { 1: 'AGAIN', 2: 'HARD', 3: 'GOOD', 4: 'EASY' };

function serializePolicy(p) {
  return {
    policyId: p.policy_id,
    scope: SCOPE_REVERSE[p.scope],
    categoryId: p.category_id || null,
    infoBitId: p.info_bit_id || null,
    algorithmKey: p.algorithm_key,
    params: p.params_json,
    isActive: Boolean(p.is_active),
    applyMode: APPLY_REVERSE[p.apply_mode],
    updatedAt: toIso(p.updated_at)
  };
}

async function resolveEffectivePolicy(context, userId, infoBitId) {
  const infoBit = await context.models.InfoBit.findByPk(infoBitId);
  if (!infoBit) throw new Error('InfoBit not found');

  const infoBitPolicy = await context.models.SchedulerPolicy.findOne({
    where: { user_id: userId, scope: 'infobit', info_bit_id: infoBitId, is_active: true }
  });
  if (infoBitPolicy) {
    return { scope: 'INFOBIT', algorithmKey: infoBitPolicy.algorithm_key, params: infoBitPolicy.params_json, sourcePolicyId: infoBitPolicy.policy_id };
  }

  const catPolicy = await context.models.SchedulerPolicy.findOne({
    where: { user_id: userId, scope: 'category', category_id: infoBit.category_id, is_active: true }
  });
  if (catPolicy) {
    return { scope: 'CATEGORY', algorithmKey: catPolicy.algorithm_key, params: catPolicy.params_json, sourcePolicyId: catPolicy.policy_id };
  }

  const userPolicy = await context.models.SchedulerPolicy.findOne({
    where: { user_id: userId, scope: 'user_default', is_active: true }
  });
  if (userPolicy) {
    return { scope: 'USER_DEFAULT', algorithmKey: userPolicy.algorithm_key, params: userPolicy.params_json, sourcePolicyId: userPolicy.policy_id };
  }

  const algorithm = await context.models.Algorithm.findByPk('fsrs');
  return {
    scope: 'USER_DEFAULT',
    algorithmKey: 'fsrs',
    params: algorithm?.default_params || {},
    sourcePolicyId: null
  };
}

const schedulingQueries = {
  schedulerPolicyPreview: async (_, { infoBitId }, context) => {
    const user = requireUser(context);
    return resolveEffectivePolicy(context, user.userId, infoBitId);
  }
};

const schedulingMutations = {
  upsertSchedulerPolicy: async (_, { input }, context) => {
    const user = requireUser(context);
    const scope = SCOPE_MAP[input.scope];
    const applyMode = APPLY_MAP[input.applyMode];

    const where = { user_id: user.userId, scope };
    if (scope === 'category') where.category_id = input.categoryId;
    if (scope === 'infobit') where.info_bit_id = input.infoBitId;

    let policy = await context.models.SchedulerPolicy.findOne({ where, paranoid: false });

    if (policy) {
      await policy.update({
        algorithm_key: input.algorithmKey,
        params_json: input.params,
        apply_mode: applyMode,
        is_active: true,
        deleted_at: null
      }, { paranoid: false });
    } else {
      policy = await context.models.SchedulerPolicy.create({
        policy_id: randomUUID(),
        user_id: user.userId,
        scope,
        category_id: scope === 'category' ? input.categoryId : null,
        info_bit_id: scope === 'infobit' ? input.infoBitId : null,
        algorithm_key: input.algorithmKey,
        params_json: input.params,
        apply_mode: applyMode,
        is_active: true
      });
    }

    return serializePolicy(policy);
  },

  removeSchedulerPolicy: async (_, { policyId }, context) => {
    const user = requireUser(context);
    const policy = await context.models.SchedulerPolicy.findOne({
      where: { policy_id: policyId, user_id: user.userId }
    });
    if (!policy) throw new Error('Policy not found');
    await policy.update({ is_active: false, deleted_at: new Date() });
    return true;
  },

  recalculateSchedules: async (_, { scope, categoryId, infoBitId }, context) => {
    const user = requireUser(context);
    const dbScope = SCOPE_MAP[scope];

    let infoBitIds = [];
    if (dbScope === 'infobit' && infoBitId) {
      infoBitIds = [infoBitId];
    } else if (dbScope === 'category' && categoryId) {
      const bits = await context.models.InfoBit.findAll({
        where: { user_id: user.userId, category_id: categoryId, status: 'active' },
        attributes: ['info_bit_id']
      });
      infoBitIds = bits.map((b) => b.info_bit_id);
    } else {
      const bits = await context.models.InfoBit.findAll({
        where: { user_id: user.userId, status: 'active' },
        attributes: ['info_bit_id']
      });
      infoBitIds = bits.map((b) => b.info_bit_id);
    }

    for (const ibId of infoBitIds) {
      const resolved = await resolveEffectivePolicy(context, user.userId, ibId);

      const logs = await context.models.FSRSReviewLog.findAll({
        where: { info_bit_id: ibId },
        order: [['reviewed_at', 'ASC']]
      });

      let card = buildInitialFsrsState();
      for (const log of logs) {
        const ratingEnum = RATING_REVERSE[log.rating];
        if (!ratingEnum) continue;

        const result = computeReview({
          currentCard: card,
          ratingEnum,
          params: resolved.params,
          reviewDate: new Date(log.reviewed_at)
        });
        card = {
          due: result.card.due,
          stability: result.card.stability,
          difficulty: result.card.difficulty,
          elapsed_days: result.card.elapsed_days,
          scheduled_days: result.card.scheduled_days,
          learning_steps: result.card.learning_steps || 0,
          reps: result.card.reps,
          lapses: result.card.lapses,
          state: result.card.state,
          last_review: result.card.last_review
        };
      }

      await context.models.FSRSCardState.update(
        {
          due: card.due,
          stability: card.stability,
          difficulty: card.difficulty,
          elapsed_days: card.elapsed_days,
          scheduled_days: card.scheduled_days,
          learning_steps: card.learning_steps,
          reps: card.reps,
          lapses: card.lapses,
          state: card.state,
          last_review: card.last_review
        },
        { where: { info_bit_id: ibId } }
      );

      await context.models.InfoBit.update(
        { due_at: card.due },
        { where: { info_bit_id: ibId } }
      );
    }

    return true;
  }
};

module.exports = { schedulingQueries, schedulingMutations, resolveEffectivePolicy };
