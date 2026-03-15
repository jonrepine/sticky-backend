/**
 * FSRS engine — thin wrapper around the `ts-fsrs` library.
 *
 * Why this boundary exists:
 *   The resolvers should never import `ts-fsrs` directly. This module provides
 *   a stable internal API so that:
 *   - If `ts-fsrs` changes its interface, only this file needs updating.
 *   - The mapping between our DB column names and FSRS's Card object is
 *     centralised here (e.g. `learning_steps`, `last_review` ↔ `last_review`).
 *   - Unit-testable in isolation (without Apollo/DB) if needed.
 *
 * Key functions:
 *   buildInitialFsrsState(now)  — creates a "New" card state for a freshly
 *                                  created InfoBit (due immediately, 0 reps).
 *   dbRowToFsrsCard(row)        — converts a `fsrs_card_states` DB row into
 *                                  the `Card` shape that ts-fsrs expects.
 *   computeReview(opts)         — runs one scheduling step: given the current
 *                                  card state, a rating, and optional FSRS
 *                                  params, returns the next card state + log.
 *   serializeScheduleState(card)— converts a ts-fsrs Card into the JSON blob
 *                                  returned to the client via `ReviewResult.stateAfter`.
 *   computeAllRatingPreviews(opts) — dry-runs `repeat()` once and returns the
 *                                  outcome for all 4 ratings (AGAIN/HARD/GOOD/
 *                                  EASY) so the frontend can show "next due"
 *                                  labels on each rating button before the user
 *                                  commits.
 *
 * FSRS ratings:
 *   AGAIN (1) — forgot / failed
 *   HARD  (2) — recalled with difficulty
 *   GOOD  (3) — recalled correctly
 *   EASY  (4) — recalled effortlessly
 */

const { fsrs, createEmptyCard, generatorParameters, Rating, State } = require('ts-fsrs');

const RATING_MAP = { AGAIN: Rating.Again, HARD: Rating.Hard, GOOD: Rating.Good, EASY: Rating.Easy };

function buildInitialFsrsState(now = new Date()) {
  const empty = createEmptyCard(now);
  return {
    due: empty.due,
    stability: empty.stability,
    difficulty: empty.difficulty,
    elapsed_days: empty.elapsed_days,
    scheduled_days: empty.scheduled_days,
    learning_steps: empty.learning_steps || 0,
    reps: empty.reps,
    lapses: empty.lapses,
    state: empty.state,
    last_review: empty.last_review || null
  };
}

function serializeScheduleState(fsrsCard) {
  return {
    due_at: fsrsCard.due,
    stability: fsrsCard.stability,
    difficulty: fsrsCard.difficulty,
    elapsed_days: fsrsCard.elapsed_days,
    scheduled_days: fsrsCard.scheduled_days,
    learning_steps: fsrsCard.learning_steps || 0,
    reps: fsrsCard.reps,
    lapses: fsrsCard.lapses,
    state: fsrsCard.state,
    last_review_at: fsrsCard.last_review
  };
}

function dbRowToFsrsCard(row) {
  return {
    due: new Date(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    learning_steps: row.learning_steps || 0,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    last_review: row.last_review ? new Date(row.last_review) : null
  };
}

function computeReview({ currentCard, ratingEnum, params, reviewDate }) {
  const genParams = generatorParameters(params || {});
  const scheduler = fsrs(genParams);

  const rating = RATING_MAP[ratingEnum];
  if (rating === undefined) throw new Error(`Invalid rating: ${ratingEnum}`);

  const result = scheduler.repeat(currentCard, reviewDate || new Date());
  const chosen = result[rating];

  return {
    card: chosen.card,
    log: chosen.log
  };
}

function computeAllRatingPreviews({ currentCard, params, reviewDate }) {
  const genParams = generatorParameters(params || {});
  const scheduler = fsrs(genParams);
  const now = reviewDate || new Date();
  const result = scheduler.repeat(currentCard, now);

  return ['AGAIN', 'HARD', 'GOOD', 'EASY'].map((ratingEnum) => {
    const r = RATING_MAP[ratingEnum];
    const outcome = result[r];
    return {
      rating: ratingEnum,
      nextDueAt: outcome.card.due,
      scheduledDays: outcome.card.scheduled_days,
      newStability: outcome.card.stability,
      newDifficulty: outcome.card.difficulty,
      newState: outcome.card.state
    };
  });
}

const STATE_LABELS = { 0: 'New', 1: 'Learning', 2: 'Review', 3: 'Relearning' };

function formatDurationSeconds(seconds) {
  const abs = Math.abs(Math.round(seconds));
  if (abs < 60) return abs === 1 ? '1 second' : `${abs} seconds`;
  if (abs < 3600) {
    const m = Math.round(abs / 60);
    return m === 1 ? '1 minute' : `${m} minutes`;
  }
  if (abs < 86400) {
    const h = Math.round(abs / 3600);
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  const d = Math.round(abs / 86400);
  if (d < 30) return d === 1 ? '1 day' : `${d} days`;
  if (d < 365) {
    const mo = Math.round(d / 30);
    return mo === 1 ? '1 month' : `${mo} months`;
  }
  const y = Math.round(d / 365);
  return y === 1 ? '1 year' : `${y} years`;
}

/**
 * Rich outcome previews for the V2 `reviewOutcomePreview` query.
 * Returns all 4 rating outcomes with human-readable display text,
 * scheduled seconds, full state-after JSON, and fuzz indicator.
 */
function computeOutcomePreviews({ currentCard, params, reviewDate }) {
  const mergedParams = params || {};
  const genParams = generatorParameters(mergedParams);
  const scheduler = fsrs(genParams);
  const now = reviewDate || new Date();
  const result = scheduler.repeat(currentCard, now);
  const hasFuzz = mergedParams.enable_fuzz === true;

  return ['AGAIN', 'HARD', 'GOOD', 'EASY'].map((ratingEnum) => {
    const r = RATING_MAP[ratingEnum];
    const outcome = result[r];
    const nextDue = outcome.card.due;
    const scheduledSeconds = Math.max(0, Math.round((nextDue.getTime() - now.getTime()) / 1000));
    const displayText = `Next review in ${formatDurationSeconds(scheduledSeconds)}`;

    return {
      rating: ratingEnum,
      nextDueAt: nextDue,
      scheduledSeconds,
      stateAfter: serializeScheduleState(outcome.card),
      displayText,
      isEstimate: hasFuzz
    };
  });
}

module.exports = {
  buildInitialFsrsState,
  serializeScheduleState,
  dbRowToFsrsCard,
  computeReview,
  computeAllRatingPreviews,
  computeOutcomePreviews,
  formatDurationSeconds,
  RATING_MAP,
  Rating,
  State,
  STATE_LABELS
};
