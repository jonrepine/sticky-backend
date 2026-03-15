/**
 * Review resolvers — the FSRS spaced-repetition review flow.
 *
 * This file implements the core study loop:
 *   1. `dueInfoBits`          — which InfoBits are due for review right now?
 *   2. `nextReviewCard`       — which card should be shown for a given InfoBit?
 *   3. `submitReview`         — record the user's rating and advance the FSRS state.
 *
 * V2 additions:
 *   4. `reviewOutcomePreview` — pre-submit preview of all 4 rating outcomes with
 *                               human-readable display text and full state-after.
 *   5. `dueQueue`             — state-aware queue (LEARN / REVIEW / ALL) using the
 *                               FSRS state field for partitioning.
 *   6. `dailyEngagement`      — heatmap data: daily counts of items added, learned,
 *                               and reviewed, aggregated from activity_events and
 *                               fsrs_review_logs tables.
 *
 * FSRS state → queue mapping:
 *   LEARN  = State 0 (New) + State 1 (Learning) + State 3 (Relearning)
 *   REVIEW = State 2 (Review)
 */

const { randomUUID } = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const { requireUser } = require('../../shared/auth/requireUser');
const { toIso } = require('./_helpers');
const { dbRowToFsrsCard, computeReview, computeAllRatingPreviews, computeOutcomePreviews, serializeScheduleState } = require('../../infrastructure/fsrs/engine');
const { resolveEffectivePolicy } = require('./scheduling.resolvers');

const LEARN_STATES = [0, 1, 3];
const REVIEW_STATES = [2];

const reviewQueries = {
  dueInfoBits: async (_, { cursor, limit = 20 }, context) => {
    const user = requireUser(context);

    const where = {
      user_id: user.userId,
      status: 'active'
    };

    const now = new Date();

    const infoBits = await context.models.InfoBit.findAll({
      where,
      include: [{
        model: context.models.FSRSCardState,
        as: 'fsrsCardState',
        where: { due: { [Op.lte]: now } },
        required: true
      }],
      order: [[{ model: context.models.FSRSCardState, as: 'fsrsCardState' }, 'due', 'ASC']],
      limit
    });

    return infoBits.map((ib) => ({
      infoBitId: ib.info_bit_id,
      title: ib.title,
      dueAt: toIso(ib.fsrsCardState.due)
    }));
  },

  nextReviewCard: async (_, { infoBitId }, context) => {
    const user = requireUser(context);

    const infoBit = await context.models.InfoBit.findOne({
      where: { info_bit_id: infoBitId, user_id: user.userId, status: 'active' },
      include: [{ model: context.models.FSRSCardState, as: 'fsrsCardState' }]
    });

    if (!infoBit) throw new Error('InfoBit not found');
    if (!infoBit.fsrsCardState) throw new Error('No schedule state found');

    const mongoDoc = await context.mongoModels.InfoBitContent.findById(infoBitId).lean();
    if (!mongoDoc) throw new Error('InfoBit content not found');

    const activeCards = mongoDoc.cards.filter((c) => c.status === 'active');
    if (activeCards.length === 0) throw new Error('No active cards available');

    let selected;
    if (activeCards.length > 1 && mongoDoc.rotation?.last_presented_card_id) {
      const others = activeCards.filter((c) => c.card_id !== mongoDoc.rotation.last_presented_card_id);
      selected = others.length > 0
        ? others[Math.floor(Math.random() * others.length)]
        : activeCards[Math.floor(Math.random() * activeCards.length)];
    } else {
      selected = activeCards[Math.floor(Math.random() * activeCards.length)];
    }

    const currentCard = dbRowToFsrsCard(infoBit.fsrsCardState);
    const effectivePolicy = await resolveEffectivePolicy(context, user.userId, infoBitId);
    const previews = computeAllRatingPreviews({
      currentCard,
      params: effectivePolicy.params || {},
      reviewDate: new Date()
    });

    return {
      infoBitId,
      card: {
        cardId: selected.card_id,
        infoBitId,
        status: selected.status,
        frontBlocks: selected.front_blocks || [],
        backBlocks: selected.back_blocks || [],
        createdAt: toIso(selected.created_at),
        updatedAt: toIso(selected.updated_at)
      },
      dueAt: toIso(infoBit.fsrsCardState.due),
      allowedRatings: ['AGAIN', 'HARD', 'GOOD', 'EASY'],
      ratingPreviews: previews.map((p) => ({ ...p, nextDueAt: toIso(p.nextDueAt) }))
    };
  },

  reviewSchedulePreview: async (_, { infoBitId }, context) => {
    const user = requireUser(context);

    const infoBit = await context.models.InfoBit.findOne({
      where: { info_bit_id: infoBitId, user_id: user.userId, status: 'active' },
      include: [{ model: context.models.FSRSCardState, as: 'fsrsCardState' }]
    });

    if (!infoBit) throw new Error('InfoBit not found');
    if (!infoBit.fsrsCardState) throw new Error('No schedule state found');

    const currentCard = dbRowToFsrsCard(infoBit.fsrsCardState);
    const effectivePolicy = await resolveEffectivePolicy(context, user.userId, infoBitId);
    const previews = computeAllRatingPreviews({
      currentCard,
      params: effectivePolicy.params || {},
      reviewDate: new Date()
    });

    return previews.map((p) => ({ ...p, nextDueAt: toIso(p.nextDueAt) }));
  },

  reviewOutcomePreview: async (_, { input }, context) => {
    const user = requireUser(context);
    const { infoBitId, cardId, asOf } = input;
    const reviewDate = asOf ? new Date(asOf) : new Date();

    const infoBit = await context.models.InfoBit.findOne({
      where: { info_bit_id: infoBitId, user_id: user.userId, status: 'active' },
      include: [{ model: context.models.FSRSCardState, as: 'fsrsCardState' }]
    });
    if (!infoBit) throw new Error('InfoBit not found');
    if (!infoBit.fsrsCardState) throw new Error('No schedule state found');

    const mongoDoc = await context.mongoModels.InfoBitContent.findById(infoBitId).lean();
    if (!mongoDoc) throw new Error('InfoBit content not found');
    const cardExists = mongoDoc.cards.some((c) => c.card_id === cardId && c.status === 'active');
    if (!cardExists) throw new Error('Card not found');

    const currentCard = dbRowToFsrsCard(infoBit.fsrsCardState);
    const effectivePolicy = await resolveEffectivePolicy(context, user.userId, infoBitId);
    const outcomes = computeOutcomePreviews({
      currentCard,
      params: effectivePolicy.params || {},
      reviewDate
    });

    return {
      infoBitId,
      cardId,
      asOf: reviewDate.toISOString(),
      outcomes: outcomes.map((o) => ({ ...o, nextDueAt: toIso(o.nextDueAt) }))
    };
  },

  dueQueue: async (_, { kind, limit = 50 }, context) => {
    const user = requireUser(context);
    const now = new Date();

    const stateFilter =
      kind === 'LEARN' ? LEARN_STATES :
        kind === 'REVIEW' ? REVIEW_STATES :
          null;

    const fsrsWhere = { due: { [Op.lte]: now } };
    if (stateFilter) fsrsWhere.state = { [Op.in]: stateFilter };

    const infoBits = await context.models.InfoBit.findAll({
      where: { user_id: user.userId, status: 'active' },
      include: [{
        model: context.models.FSRSCardState,
        as: 'fsrsCardState',
        where: fsrsWhere,
        required: true
      }],
      order: [[{ model: context.models.FSRSCardState, as: 'fsrsCardState' }, 'due', 'ASC']],
      limit
    });

    return infoBits.map((ib) => ({
      infoBitId: ib.info_bit_id,
      title: ib.title,
      dueAt: toIso(ib.fsrsCardState.due),
      fsrsState: ib.fsrsCardState.state,
      reps: ib.fsrsCardState.reps,
      lapses: ib.fsrsCardState.lapses
    }));
  },

  dailyEngagement: async (_, { windowDays = 365 }, context) => {
    const user = requireUser(context);
    const clampedWindow = Math.min(Math.max(windowDays, 1), 365);
    const endDate = new Date();
    const startDate = new Date();
    startDate.setUTCHours(0, 0, 0, 0);
    startDate.setUTCDate(startDate.getUTCDate() - clampedWindow + 1);
    endDate.setUTCHours(23, 59, 59, 999);

    const seq = context.models.User.sequelize;

    const [addedRows] = await seq.query(
      `SELECT DATE(occurred_at AT TIME ZONE 'UTC') AS day, COUNT(*)::int AS cnt
       FROM activity_events
       WHERE user_id = :userId AND event_type = 'infobit.created'
         AND occurred_at >= :start AND occurred_at <= :end
       GROUP BY day`,
      { replacements: { userId: user.userId, start: startDate, end: endDate }, type: QueryTypes.SELECT, raw: true }
    ).then((rows) => [rows]);

    const [reviewRows] = await seq.query(
      `SELECT DATE(reviewed_at AT TIME ZONE 'UTC') AS day,
              SUM(CASE WHEN (state_before->>'state')::int IN (0,1,3) THEN 1 ELSE 0 END)::int AS learned,
              SUM(CASE WHEN (state_before->>'state')::int = 2 THEN 1 ELSE 0 END)::int AS reviewed
       FROM fsrs_review_logs
       WHERE user_id = :userId
         AND reviewed_at >= :start AND reviewed_at <= :end
       GROUP BY day`,
      { replacements: { userId: user.userId, start: startDate, end: endDate }, type: QueryTypes.SELECT, raw: true }
    ).then((rows) => [rows]);

    const addedMap = new Map(addedRows.map((r) => [r.day, r.cnt]));
    const reviewMap = new Map(reviewRows.map((r) => [r.day, { learned: r.learned, reviewed: r.reviewed }]));

    const points = [];
    const cursor = new Date(startDate);
    while (cursor <= endDate) {
      const key = cursor.toISOString().slice(0, 10);
      const added = addedMap.get(key) || 0;
      const rev = reviewMap.get(key) || { learned: 0, reviewed: 0 };
      points.push({
        date: key,
        addedCount: added,
        learnedCount: rev.learned,
        reviewedCount: rev.reviewed,
        totalCount: added + rev.learned + rev.reviewed
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return points;
  }
};

const reviewMutations = {
  submitReview: async (_, { input }, context) => {
    const user = requireUser(context);

    const infoBit = await context.models.InfoBit.findOne({
      where: { info_bit_id: input.infoBitId, user_id: user.userId, status: 'active' },
      include: [{ model: context.models.FSRSCardState, as: 'fsrsCardState' }]
    });

    if (!infoBit) throw new Error('InfoBit not found');
    if (!infoBit.fsrsCardState) throw new Error('No schedule state');

    const card = await context.models.Card.findOne({
      where: { card_id: input.cardId, info_bit_id: input.infoBitId }
    });
    if (!card) throw new Error('Card not found');

    const currentCard = dbRowToFsrsCard(infoBit.fsrsCardState);
    const stateBefore = { ...currentCard };
    const now = new Date();

    const effectivePolicy = await resolveEffectivePolicy(context, user.userId, input.infoBitId);
    const params = effectivePolicy.params || {};

    const { card: newCard } = computeReview({
      currentCard,
      ratingEnum: input.rating,
      params,
      reviewDate: now
    });

    const reviewLogId = randomUUID();

    const tx = await context.models.User.sequelize.transaction();

    try {
      await context.models.FSRSReviewLog.create(
        {
          fsrs_review_log_id: reviewLogId,
          user_id: user.userId,
          info_bit_id: input.infoBitId,
          card_id: input.cardId,
          algorithm_key: effectivePolicy.algorithmKey,
          algorithm_version: 'ts-fsrs-v1',
          rating: { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 }[input.rating],
          response_ms: input.responseMs || null,
          reviewed_at: now,
          effective_policy_scope: effectivePolicy.scope.toLowerCase(),
          effective_params_snapshot: params,
          state_before: stateBefore,
          state_after: {
            due: newCard.due,
            stability: newCard.stability,
            difficulty: newCard.difficulty,
            elapsed_days: newCard.elapsed_days,
            scheduled_days: newCard.scheduled_days,
            learning_steps: newCard.learning_steps || 0,
            reps: newCard.reps,
            lapses: newCard.lapses,
            state: newCard.state,
            last_review: newCard.last_review
          }
        },
        { transaction: tx }
      );

      await infoBit.fsrsCardState.update(
        {
          due: newCard.due,
          stability: newCard.stability,
          difficulty: newCard.difficulty,
          elapsed_days: newCard.elapsed_days,
          scheduled_days: newCard.scheduled_days,
          learning_steps: newCard.learning_steps || 0,
          reps: newCard.reps,
          lapses: newCard.lapses,
          state: newCard.state,
          last_review: newCard.last_review
        },
        { transaction: tx }
      );

      await infoBit.update({ due_at: newCard.due }, { transaction: tx });
      await card.update({ last_reviewed_at: now }, { transaction: tx });

      await tx.commit();

      await context.mongoModels.InfoBitContent.updateOne(
        { _id: input.infoBitId },
        { $set: { 'rotation.last_presented_card_id': input.cardId, 'rotation.last_presented_at': now } }
      );

      return {
        reviewEventId: reviewLogId,
        nextDueAt: toIso(newCard.due),
        stateAfter: serializeScheduleState(newCard)
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
};

module.exports = { reviewQueries, reviewMutations };
