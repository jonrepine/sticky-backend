/**
 * GraphQL Schema Definition Language (SDL) — the complete API contract.
 *
 * Organisation:
 *   Types are grouped by domain: Auth → Core (User, Category) → InfoBit →
 *   Cards → Tags → FSRS Review → Scheduler → Flags → Dashboard.
 *   Query and Mutation blocks follow the same ordering.
 *
 * Naming conventions:
 *   - Types:      PascalCase (InfoBit, CardContent, ReviewPrompt)
 *   - Inputs:     <Action><Entity>Input (CreateInfoBitInput, SubmitReviewInput)
 *   - Enums:      PascalCase with SCREAMING_CASE values
 *   - Fields:     camelCase (infoBitId, frontBlocks)
 *   - IDs:        Always `ID!` scalar
 *   - Dates:      ISO-8601 strings (not a custom DateTime scalar, to keep the
 *                 client simple — parsing is the frontend's responsibility)
 *
 * Pagination:
 *   `infoBits` uses cursor-based pagination (InfoBitConnection with nextCursor).
 *   Other list queries (tags, flags, dueInfoBits) return flat arrays since they
 *   are bounded by user scope and not expected to exceed a few hundred items in V1.
 *
 * The `JSON` scalar:
 *   Used for FSRS params and policy configs where the shape is defined by the
 *   algorithm, not by our schema. Validated at the resolver level.
 */

const typeDefs = `#graphql
  type Health {
    ok: Boolean!
    service: String!
    featureFlags: JSON
  }

  type User {
    userId: ID!
    email: String
    username: String
    timezone: String!
    createdAt: String!
    updatedAt: String!
  }

  type Category {
    categoryId: ID!
    name: String!
    slug: String!
    ownerType: String!
    isActive: Boolean!
    doctrineVersion: String
    memoryArchetype: String
  }

  type CardBlock {
    type: String!
    text: String
    url: String
    alt: String
    mimeType: String
    durationMs: Int
  }

  type CardContent {
    cardId: ID!
    infoBitId: ID!
    status: String!
    frontBlocks: [CardBlock!]!
    backBlocks: [CardBlock!]!
    createdAt: String!
    updatedAt: String!
  }

  type InfoBit {
    infoBitId: ID!
    title: String!
    status: String!
    category: Category!
    tags: [String!]!
    cards: [CardContent!]!
    dueAt: String
    noteSpec: JSON
    createdAt: String!
    updatedAt: String!
  }

  type AuthPayload {
    accessToken: String!
    refreshToken: String!
    user: User!
  }

  input SignUpInput {
    email: String!
    password: String!
    timezone: String!
    username: String!
  }

  input SignInInput {
    emailOrUsername: String!
    password: String!
    deviceName: String
  }

  input CardBlockInput {
    type: String!
    text: String
    url: String
    alt: String
    mimeType: String
    durationMs: Int
  }

  input CreateCardInput {
    frontBlocks: [CardBlockInput!]!
    backBlocks: [CardBlockInput!]!
  }

  input CreateInfoBitInput {
    title: String!
    categoryId: ID!
    tags: [String!]
    originalContent: String
    cards: [CreateCardInput!]!
    noteSpec: JSON
  }

  input UpdateMeInput {
    username: String
    timezone: String
  }

  input UpdateInfoBitInput {
    infoBitId: ID!
    title: String
    categoryId: ID
    tags: [String!]
  }

  enum InfoBitStatus {
    active
    archived
    deleted
    mastered
  }

  # ── V2: NoteSpec Enums ──────────────────────────────────────

  enum DeepAttribute {
    SOURCE
    CONTEXT
    SIGNIFICANCE
    USAGE
    DOMAIN
    CONTRAST
    OCCASION
    APPLICATION
  }

  enum ExactnessMode {
    GIST
    TERM_EXACT
    PHRASE_EXACT
    VERBATIM
  }

  type InfoBitConnection {
    edges: [InfoBit!]!
    nextCursor: String
  }

  type BulkInfoBitMutationResult {
    infoBitIds: [ID!]!
    affectedCount: Int!
  }

  type Tag {
    tagId: ID!
    name: String!
    slug: String!
    isActive: Boolean!
    archivedAt: String
  }

  type BulkTagMutationResult {
    tagIds: [ID!]!
    affectedCount: Int!
  }

  input UpdateCardInput {
    cardId: ID!
    frontBlocks: [CardBlockInput!]
    backBlocks: [CardBlockInput!]
  }

  type BulkCardMutationResult {
    cardIds: [ID!]!
    affectedCount: Int!
  }

  scalar JSON

  enum FsrsRating {
    AGAIN
    HARD
    GOOD
    EASY
  }

  type DueInfoBit {
    infoBitId: ID!
    title: String!
    dueAt: String!
  }

  type RatingPreview {
    rating: FsrsRating!
    nextDueAt: String!
    scheduledDays: Float!
    newStability: Float!
    newDifficulty: Float!
    newState: Int!
  }

  type ReviewPrompt {
    infoBitId: ID!
    card: CardContent!
    dueAt: String!
    allowedRatings: [FsrsRating!]!
    ratingPreviews: [RatingPreview!]!
  }

  type ReviewResult {
    reviewEventId: ID!
    nextDueAt: String!
    stateAfter: JSON!
  }

  input SubmitReviewInput {
    infoBitId: ID!
    cardId: ID!
    rating: FsrsRating!
    responseMs: Int
  }

  enum SchedulerScope {
    USER_DEFAULT
    CATEGORY
    INFOBIT
  }

  enum PolicyApplyMode {
    FUTURE_ONLY
    RECALCULATE_EXISTING
  }

  type SchedulerPolicy {
    policyId: ID!
    scope: SchedulerScope!
    categoryId: ID
    infoBitId: ID
    algorithmKey: String!
    params: JSON!
    isActive: Boolean!
    applyMode: PolicyApplyMode!
    updatedAt: String!
  }

  type ResolvedSchedulerPolicy {
    scope: SchedulerScope!
    algorithmKey: String!
    params: JSON!
    sourcePolicyId: ID
  }

  input UpsertSchedulerPolicyInput {
    scope: SchedulerScope!
    categoryId: ID
    infoBitId: ID
    algorithmKey: String!
    params: JSON!
    applyMode: PolicyApplyMode!
  }

  enum FlagEntityType {
    INFOBIT
    CARD
    TAG
  }

  enum FlagType {
    NEEDS_EDIT
    NEEDS_REGENERATE
    NEEDS_MEDIA
    LOW_QUALITY
    OTHER
  }

  enum FlagStatus {
    OPEN
    RESOLVED
  }

  type Flag {
    flagId: ID!
    entityType: FlagEntityType!
    entityId: ID!
    flagType: FlagType!
    note: String
    status: FlagStatus!
    createdAt: String!
    resolvedAt: String
  }

  input CreateFlagInput {
    entityType: FlagEntityType!
    entityId: ID!
    flagType: FlagType!
    note: String
  }

  enum GenerationPolicyScope {
    USER_DEFAULT
    CATEGORY
    INFOBIT
  }

  type GenerationPolicy {
    policyId: ID!
    scope: GenerationPolicyScope!
    categoryId: ID
    infoBitId: ID
    isActive: Boolean!
    config: JSON!
    updatedAt: String!
  }

  type ResolvedGenerationPolicy {
    scope: GenerationPolicyScope!
    config: JSON!
    sourcePolicyId: ID
  }

  type UserLearningPreferences {
    newSessionDefaultCategoryId: ID
    defaultSocraticEnabled: Boolean!
    defaultTags: [String!]!
    updatedAt: String!
  }

  type PolicyScaleLevel {
    level: Int!
    label: String!
    blurb: String!
    implication: String!
  }

  type GenerationPolicyScaleMetadata {
    creativity: [PolicyScaleLevel!]!
    strictness: [PolicyScaleLevel!]!
  }

  input UpsertGenerationPolicyInput {
    scope: GenerationPolicyScope!
    categoryId: ID
    infoBitId: ID
    config: JSON!
  }

  input UpdateLearningPreferencesInput {
    newSessionDefaultCategoryId: ID
    defaultSocraticEnabled: Boolean
    defaultTags: [String!]
  }

  # ── V2: Review Outcome Preview ──────────────────────────────

  input ReviewOutcomePreviewInput {
    infoBitId: ID!
    cardId: ID!
    asOf: String
  }

  type RatingOutcome {
    rating: FsrsRating!
    nextDueAt: String!
    scheduledSeconds: Int!
    stateAfter: JSON!
    displayText: String!
    isEstimate: Boolean!
  }

  type ReviewOutcomePreview {
    infoBitId: ID!
    cardId: ID!
    asOf: String!
    outcomes: [RatingOutcome!]!
  }

  # ── V2: Due Queue ───────────────────────────────────────────

  enum DueQueueKind {
    LEARN
    REVIEW
    ALL
  }

  type DueQueueItem {
    infoBitId: ID!
    title: String!
    dueAt: String!
    fsrsState: Int!
    reps: Int!
    lapses: Int!
  }

  # ── V2: Daily Engagement Heatmap ────────────────────────────

  type DailyEngagementPoint {
    date: String!
    addedCount: Int!
    learnedCount: Int!
    reviewedCount: Int!
    totalCount: Int!
  }

  # ── V2: NoteSpec Validator ────────────────────────────────

  type NoteSpecCheck {
    name: String!
    passed: Boolean!
    message: String
  }

  type NoteSpecValidationResult {
    isValid: Boolean!
    checks: [NoteSpecCheck!]!
  }

  type Query {
    health: Health!
    me: User
    categories: [Category!]!
    infoBits(cursor: String, limit: Int, categoryId: ID, status: InfoBitStatus): InfoBitConnection!
    infoBit(infoBitId: ID!): InfoBit
    tags: [Tag!]!
    dueInfoBits(cursor: String, limit: Int): [DueInfoBit!]!
    nextReviewCard(infoBitId: ID!): ReviewPrompt!
    reviewSchedulePreview(infoBitId: ID!): [RatingPreview!]!
    reviewOutcomePreview(input: ReviewOutcomePreviewInput!): ReviewOutcomePreview!
    dueQueue(kind: DueQueueKind!, limit: Int): [DueQueueItem!]!
    dailyEngagement(windowDays: Int): [DailyEngagementPoint!]!
    schedulerPolicyPreview(infoBitId: ID!): ResolvedSchedulerPolicy!
    flags(status: FlagStatus, entityType: FlagEntityType): [Flag!]!
    dashboardInfoBits(limitPerTag: Int, tagLimit: Int): DashboardInfoBits!
    generationPolicyScaleMetadata: GenerationPolicyScaleMetadata!
    generationPolicyPreview(infoBitId: ID!): ResolvedGenerationPolicy!
    generationPolicyByCategory(categoryId: ID!): GenerationPolicy
    myLearningPreferences: UserLearningPreferences!
    validateNoteSpec(infoBitId: ID!): NoteSpecValidationResult!
  }

  type InfoBitsByTagSection {
    tag: Tag!
    infoBits: [InfoBit!]!
  }

  type DashboardInfoBits {
    flaggedInfoBits: [InfoBit!]!
    flaggedCards: [CardContent!]!
    sectionsByTag: [InfoBitsByTagSection!]!
  }

  type Mutation {
    signUp(input: SignUpInput!): AuthPayload!
    signIn(input: SignInInput!): AuthPayload!
    signOut: Boolean!
    signOutAllSessions: Boolean!
    refreshSession(refreshToken: String!): AuthPayload!
    updateMe(input: UpdateMeInput!): User!
    createInfoBit(input: CreateInfoBitInput!): InfoBit!
    updateInfoBit(input: UpdateInfoBitInput!): InfoBit!
    archiveInfoBit(infoBitId: ID!): InfoBit!
    deleteInfoBit(infoBitId: ID!): InfoBit!
    markInfoBitMastered(infoBitId: ID!): InfoBit!
    archiveInfoBits(infoBitIds: [ID!]!): BulkInfoBitMutationResult!
    deleteInfoBits(infoBitIds: [ID!]!): BulkInfoBitMutationResult!
    attachTags(infoBitId: ID!, tags: [String!]!): InfoBit!
    detachTags(infoBitId: ID!, tagIds: [ID!]!): InfoBit!
    archiveTag(tagId: ID!): Tag!
    deleteTag(tagId: ID!): Tag!
    archiveTags(tagIds: [ID!]!): BulkTagMutationResult!
    deleteTags(tagIds: [ID!]!): BulkTagMutationResult!
    addCard(infoBitId: ID!, input: CreateCardInput!): CardContent!
    updateCardContent(input: UpdateCardInput!): CardContent!
    archiveCard(cardId: ID!): CardContent!
    deleteCard(cardId: ID!): CardContent!
    archiveCards(cardIds: [ID!]!): BulkCardMutationResult!
    deleteCards(cardIds: [ID!]!): BulkCardMutationResult!
    submitReview(input: SubmitReviewInput!): ReviewResult!
    upsertSchedulerPolicy(input: UpsertSchedulerPolicyInput!): SchedulerPolicy!
    removeSchedulerPolicy(policyId: ID!): Boolean!
    recalculateSchedules(scope: SchedulerScope!, categoryId: ID, infoBitId: ID): Boolean!
    createFlag(input: CreateFlagInput!): Flag!
    resolveFlag(flagId: ID!): Flag!
    upsertGenerationPolicy(input: UpsertGenerationPolicyInput!): GenerationPolicy!
    removeGenerationPolicy(policyId: ID!): Boolean!
    updateLearningPreferences(input: UpdateLearningPreferencesInput!): UserLearningPreferences!
  }
`;

module.exports = typeDefs;
