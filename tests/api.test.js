/**
 * Integration tests for all currently implemented API operations.
 *
 * Strategy:
 *   These are *integration* tests — they boot a real Apollo Server connected to
 *   real local Postgres + MongoDB instances (configured via .env). Tables are
 *   force-synced (dropped/recreated) once at suite start for a clean slate.
 *   Tests run sequentially (`--runInBand`) because they share DB state.
 *
 * Organisation (maps 1:1 to resolver domains):
 *   1.  health            — stateless sanity check
 *   2.  signUp            — registration, validation, activity logging
 *   3.  signIn            — authentication, case-insensitivity
 *   3b. signOut           — session revocation
 *   3c. signOutAllSessions— bulk session revocation
 *   3d. refreshSession    — token rotation, replay detection
 *   3e. updateMe          — profile updates
 *   4.  me                — auth-aware user query
 *   5.  categories        — public system data
 *   6.  createInfoBit     — dual-write, FSRS init, tags, validation
 *   7.  infoBits          — pagination, filters, user isolation
 *   8.  infoBit (single)  — single fetch, ownership
 *   9.  updateInfoBit     — partial updates, Mongo sync
 *   10. lifecycle         — archive, delete, master transitions
 *   11. bulk + filters    — bulk ops, status/category/pagination filters
 *   12. tags              — attach, detach, archive, delete, bulk, isolation
 *   13. cards             — add, update, archive, delete, bulk, isolation
 *   14. FSRS review flow  — due list, card rotation, submit, policy usage
 *   15. scheduler policy  — CRUD, hierarchy, category override, recalculate
 *   16. flags             — create, resolve, filter, isolation
 *   17. dashboard         — composite query, auth
 *   18. data consistency  — verify SQL + Mongo dual-write integrity
 *
 * Coverage approach:
 *   Each describe block covers: happy path, validation errors, auth rejection,
 *   user isolation (user A cannot see/modify user B's data), and DB-level
 *   side effects (activity events, FSRS state rows, Mongo documents).
 *
 * Run: npm test
 */

const { init, teardown, gql, gqlAuth, createTestUser, getModels } = require('./setup');

beforeAll(async () => {
  await init();
}, 30000); // allow time for DB connections + sync

afterAll(async () => {
  await teardown();
});

// ─────────────────────────────────────────────────────────────
// 1. Health check
// ─────────────────────────────────────────────────────────────
describe('health', () => {
  it('returns ok and service name', async () => {
    const result = await gql(`query { health { ok service } }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.health).toEqual({
      ok: true,
      service: 'spaced-rep-api'
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Auth: signUp
// ─────────────────────────────────────────────────────────────
describe('signUp', () => {
  it('creates a new user and returns tokens', async () => {
    const result = await gql(
      `mutation ($input: SignUpInput!) {
        signUp(input: $input) {
          accessToken
          refreshToken
          user { userId email timezone username }
        }
      }`,
      {
        input: {
          email: 'signup@test.com',
          password: 'Password123',
          timezone: 'Africa/Johannesburg',
          username: 'signuptester'
        }
      }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.signUp.accessToken).toBeTruthy();
    expect(result.data.signUp.refreshToken).toBeTruthy();
    expect(result.data.signUp.user.email).toBe('signup@test.com');
    expect(result.data.signUp.user.timezone).toBe('Africa/Johannesburg');
    expect(result.data.signUp.user.username).toBe('signuptester');
  });

  it('rejects duplicate email', async () => {
    // First signup should succeed (or already exists from above)
    await gql(
      `mutation ($input: SignUpInput!) {
        signUp(input: $input) { accessToken }
      }`,
      {
        input: {
          email: 'dupe@test.com',
          password: 'Password123',
          timezone: 'UTC',
          username: 'dupe_user_one'
        }
      }
    );

    // Second signup with same email should fail
    const result = await gql(
      `mutation ($input: SignUpInput!) {
        signUp(input: $input) { accessToken }
      }`,
      {
        input: {
          email: 'dupe@test.com',
          password: 'Password123',
          timezone: 'UTC',
          username: 'dupe_user_two'
        }
      }
    );

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/already registered/i);
  });

  it('rejects short password', async () => {
    const result = await gql(
      `mutation ($input: SignUpInput!) {
        signUp(input: $input) { accessToken }
      }`,
      {
        input: {
          email: 'shortpw@test.com',
          password: 'short',
          timezone: 'UTC',
          username: 'shortpw_user'
        }
      }
    );

    expect(result.errors).toBeDefined();
  });

  it('normalizes email to lowercase', async () => {
    const result = await gql(
      `mutation ($input: SignUpInput!) {
        signUp(input: $input) {
          user { email }
        }
      }`,
      {
        input: {
          email: 'UPPER@Test.COM',
          password: 'Password123',
          timezone: 'UTC',
          username: 'upper_user'
        }
      }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.signUp.user.email).toBe('upper@test.com');
  });

  it('rejects duplicate username', async () => {
    await gql(
      `mutation ($input: SignUpInput!) { signUp(input: $input) { accessToken } }`,
      {
        input: {
          email: 'sameuser1@test.com',
          password: 'Password123',
          timezone: 'UTC',
          username: 'unique_slug_xyz'
        }
      }
    );
    const result = await gql(
      `mutation ($input: SignUpInput!) { signUp(input: $input) { accessToken } }`,
      {
        input: {
          email: 'sameuser2@test.com',
          password: 'Password123',
          timezone: 'UTC',
          username: 'unique_slug_xyz'
        }
      }
    );
    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/username.*taken/i);
  });

  it('rejects invalid username (too short)', async () => {
    const result = await gql(
      `mutation ($input: SignUpInput!) { signUp(input: $input) { accessToken } }`,
      {
        input: {
          email: 'badname@test.com',
          password: 'Password123',
          timezone: 'UTC',
          username: 'ab'
        }
      }
    );
    expect(result.errors).toBeDefined();
  });

  it('creates session and activity event in DB', async () => {
    const result = await gql(
      `mutation ($input: SignUpInput!) {
        signUp(input: $input) {
          user { userId }
        }
      }`,
      {
        input: {
          email: 'dbcheck-signup@test.com',
          password: 'Password123',
          timezone: 'UTC',
          username: 'dbcheck_user'
        }
      }
    );

    expect(result.errors).toBeUndefined();
    const userId = result.data.signUp.user.userId;
    const { models } = getModels();

    const sessions = await models.Session.findAll({ where: { user_id: userId } });
    expect(sessions).toHaveLength(1);

    const events = await models.ActivityEvent.findAll({
      where: { user_id: userId, event_type: 'auth.signup' }
    });
    expect(events).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Auth: signIn
// ─────────────────────────────────────────────────────────────
describe('signIn', () => {
  beforeAll(async () => {
    // Ensure a user exists to sign in with
    await gql(
      `mutation ($input: SignUpInput!) {
        signUp(input: $input) { accessToken }
      }`,
      {
        input: {
          email: 'signin@test.com',
          password: 'Password123',
          timezone: 'UTC',
          username: 'signin_tester'
        }
      }
    );
  });

  it('returns tokens for valid credentials', async () => {
    const result = await gql(
      `mutation ($input: SignInInput!) {
        signIn(input: $input) {
          accessToken
          refreshToken
          user { userId email }
        }
      }`,
      {
        input: {
          emailOrUsername: 'signin@test.com',
          password: 'Password123'
        }
      }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.signIn.accessToken).toBeTruthy();
    expect(result.data.signIn.user.email).toBe('signin@test.com');
  });

  it('rejects wrong password', async () => {
    const result = await gql(
      `mutation ($input: SignInInput!) {
        signIn(input: $input) { accessToken }
      }`,
      {
        input: {
          emailOrUsername: 'signin@test.com',
          password: 'WrongPassword99'
        }
      }
    );

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/invalid credentials/i);
  });

  it('rejects non-existent email', async () => {
    const result = await gql(
      `mutation ($input: SignInInput!) {
        signIn(input: $input) { accessToken }
      }`,
      {
        input: {
          emailOrUsername: 'nobody@test.com',
          password: 'Password123'
        }
      }
    );

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/invalid credentials/i);
  });

  it('is case-insensitive on email', async () => {
    const result = await gql(
      `mutation ($input: SignInInput!) {
        signIn(input: $input) {
          user { email }
        }
      }`,
      {
        input: {
          emailOrUsername: 'SIGNIN@TEST.COM',
          password: 'Password123'
        }
      }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.signIn.user.email).toBe('signin@test.com');
  });

  it('accepts optional deviceName', async () => {
    const result = await gql(
      `mutation ($input: SignInInput!) {
        signIn(input: $input) {
          accessToken
        }
      }`,
      {
        input: {
          emailOrUsername: 'signin@test.com',
          password: 'Password123',
          deviceName: 'iPhone 15 Pro'
        }
      }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.signIn.accessToken).toBeTruthy();
  });

  it('returns tokens when signing in with username', async () => {
    const result = await gql(
      `mutation ($input: SignInInput!) {
        signIn(input: $input) { accessToken user { email username } }
      }`,
      {
        input: {
          emailOrUsername: 'signin_tester',
          password: 'Password123'
        }
      }
    );
    expect(result.errors).toBeUndefined();
    expect(result.data.signIn.user.email).toBe('signin@test.com');
    expect(result.data.signIn.user.username).toBe('signin_tester');
  });

  it('signIn case-insensitive on username', async () => {
    const result = await gql(
      `mutation ($input: SignInInput!) { signIn(input: $input) { user { email } } }`,
      {
        input: {
          emailOrUsername: 'SIGNIN_TESTER',
          password: 'Password123'
        }
      }
    );
    expect(result.errors).toBeUndefined();
    expect(result.data.signIn.user.email).toBe('signin@test.com');
  });

  it('rejects malformed email (john@) with generic error', async () => {
    const result = await gql(
      `mutation ($input: SignInInput!) { signIn(input: $input) { accessToken } }`,
      {
        input: {
          emailOrUsername: 'john@',
          password: 'Password123'
        }
      }
    );
    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/invalid credentials/i);
  });
});

// ─────────────────────────────────────────────────────────────
// 3b. Auth: signOut
// ─────────────────────────────────────────────────────────────
describe('signOut', () => {
  it('revokes current session', async () => {
    const { accessToken } = await createTestUser({ email: 'signout@test.com' });
    const result = await gqlAuth(accessToken, `mutation { signOut }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.signOut).toBe(true);
  });

  it('rejects without auth', async () => {
    const result = await gql(`mutation { signOut }`);
    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/authentication required/i);
  });
});

// ─────────────────────────────────────────────────────────────
// 3c. Auth: signOutAllSessions
// ─────────────────────────────────────────────────────────────
describe('signOutAllSessions', () => {
  it('revokes all sessions for user', async () => {
    const email = 'signoutall@test.com';
    await createTestUser({ email });
    const { accessToken } = await gql(
      `mutation ($input: SignInInput!) { signIn(input: $input) { accessToken } }`,
      { input: { emailOrUsername: email, password: 'Password123' } }
    ).then(r => r.data.signIn);

    const result = await gqlAuth(accessToken, `mutation { signOutAllSessions }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.signOutAllSessions).toBe(true);
  });

  it('does not affect other users sessions', async () => {
    const { accessToken: tokenA } = await createTestUser({ email: 'signoutA@test.com' });
    const { accessToken: tokenB } = await createTestUser({ email: 'signoutB@test.com' });

    await gqlAuth(tokenA, `mutation { signOutAllSessions }`);

    const meResult = await gqlAuth(tokenB, `query { me { userId } }`);
    expect(meResult.errors).toBeUndefined();
    expect(meResult.data.me).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 3d. Auth: refreshSession
// ─────────────────────────────────────────────────────────────
describe('refreshSession', () => {
  it('issues new tokens with valid refresh token', async () => {
    const auth = await createTestUser({ email: 'refresh@test.com' });
    const result = await gql(
      `mutation ($rt: String!) { refreshSession(refreshToken: $rt) { accessToken refreshToken user { userId email } } }`,
      { rt: auth.refreshToken }
    );
    expect(result.errors).toBeUndefined();
    expect(result.data.refreshSession.accessToken).toBeTruthy();
    expect(result.data.refreshSession.refreshToken).toBeTruthy();
    expect(result.data.refreshSession.user.email).toBe('refresh@test.com');
  });

  it('revokes old session after refresh', async () => {
    const auth = await createTestUser({ email: 'refresh-revoke@test.com' });
    await gql(
      `mutation ($rt: String!) { refreshSession(refreshToken: $rt) { accessToken } }`,
      { rt: auth.refreshToken }
    );
    const result2 = await gql(
      `mutation ($rt: String!) { refreshSession(refreshToken: $rt) { accessToken } }`,
      { rt: auth.refreshToken }
    );
    expect(result2.errors).toBeDefined();
    expect(result2.errors[0].message).toMatch(/revoked/i);
  });

  it('rejects invalid refresh token', async () => {
    const result = await gql(
      `mutation ($rt: String!) { refreshSession(refreshToken: $rt) { accessToken } }`,
      { rt: 'not.a.real.token' }
    );
    expect(result.errors).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 3e. Auth: updateMe
// ─────────────────────────────────────────────────────────────
describe('updateMe', () => {
  it('updates username', async () => {
    const { accessToken } = await createTestUser({ email: 'updateme@test.com' });
    const result = await gqlAuth(
      accessToken,
      `mutation ($input: UpdateMeInput!) { updateMe(input: $input) { username } }`,
      { input: { username: 'newname' } }
    );
    expect(result.errors).toBeUndefined();
    expect(result.data.updateMe.username).toBe('newname');
  });

  it('updates timezone', async () => {
    const { accessToken } = await createTestUser({ email: 'updatetz@test.com' });
    const result = await gqlAuth(
      accessToken,
      `mutation ($input: UpdateMeInput!) { updateMe(input: $input) { timezone } }`,
      { input: { timezone: 'Europe/London' } }
    );
    expect(result.errors).toBeUndefined();
    expect(result.data.updateMe.timezone).toBe('Europe/London');
  });

  it('partial update only username, timezone unchanged', async () => {
    const { accessToken } = await createTestUser({ email: 'partialup@test.com', timezone: 'Asia/Tokyo' });
    const result = await gqlAuth(
      accessToken,
      `mutation ($input: UpdateMeInput!) { updateMe(input: $input) { username timezone } }`,
      { input: { username: 'partial' } }
    );
    expect(result.errors).toBeUndefined();
    expect(result.data.updateMe.username).toBe('partial');
    expect(result.data.updateMe.timezone).toBe('Asia/Tokyo');
  });

  it('rejects without auth', async () => {
    const result = await gql(
      `mutation ($input: UpdateMeInput!) { updateMe(input: $input) { userId } }`,
      { input: { username: 'nope' } }
    );
    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/authentication required/i);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. me (auth-aware query)
// ─────────────────────────────────────────────────────────────
describe('me', () => {
  it('returns null when unauthenticated', async () => {
    const result = await gql(`query { me { userId email } }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.me).toBeNull();
  });

  it('returns user info when authenticated', async () => {
    const { accessToken } = await createTestUser({ email: 'me@test.com' });

    const result = await gqlAuth(
      accessToken,
      `query { me { userId email timezone } }`
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.me.email).toBe('me@test.com');
    expect(result.data.me.timezone).toBe('America/New_York');
  });
});

// ─────────────────────────────────────────────────────────────
// 5. categories (public/auth-aware)
// ─────────────────────────────────────────────────────────────
describe('categories', () => {
  it('returns system categories without auth', async () => {
    const result = await gql(
      `query { categories { categoryId name slug ownerType } }`
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.categories.length).toBeGreaterThanOrEqual(10);

    const slugs = result.data.categories.map((c) => c.slug);
    expect(slugs).toContain('new-word');
    expect(slugs).toContain('new-word-plus');
    expect(slugs).toContain('technical-definition');
    expect(slugs).toContain('fact');
    expect(slugs).toContain('joke');
    expect(slugs).toContain('virtue-life-lesson');
    expect(slugs).toContain('quote-proverb-verse');
    expect(slugs).toContain('contrast-pair');
    expect(slugs).toContain('formula-rule');
    expect(slugs).toContain('procedure-workflow');

    result.data.categories.forEach((cat) => {
      expect(cat.ownerType).toBe('system');
    });
  });

  it('categories include optional metadata fields', async () => {
    const result = await gql(
      `query { categories { categoryId slug doctrineVersion memoryArchetype } }`
    );
    expect(result.errors).toBeUndefined();
    result.data.categories.forEach((cat) => {
      expect(cat).toHaveProperty('doctrineVersion');
      expect(cat).toHaveProperty('memoryArchetype');
    });
  });

  it('no duplicate slugs among system categories', async () => {
    const result = await gql(`query { categories { slug } }`);
    const slugs = result.data.categories.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

// ─────────────────────────────────────────────────────────────
// 6. createInfoBit
// ─────────────────────────────────────────────────────────────
describe('createInfoBit', () => {
  let accessToken;
  let categoryId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'infobit-create@test.com' });
    accessToken = auth.accessToken;

    // Get a category to use
    const catResult = await gqlAuth(
      accessToken,
      `query { categories { categoryId name } }`
    );
    categoryId = catResult.data.categories[0].categoryId;
  });

  it('creates an InfoBit with cards and tags', async () => {
    const result = await gqlAuth(
      accessToken,
      `mutation ($input: CreateInfoBitInput!) {
        createInfoBit(input: $input) {
          infoBitId
          title
          status
          tags
          category { categoryId name }
          cards {
            cardId
            status
            frontBlocks { type text }
            backBlocks { type text }
          }
        }
      }`,
      {
        input: {
          title: 'Serendipity',
          categoryId,
          tags: ['english', 'vocab'],
          originalContent: 'serendipity means finding something good by chance',
          cards: [
            {
              frontBlocks: [{ type: 'text', text: 'Define serendipity' }],
              backBlocks: [{ type: 'text', text: 'Finding valuable things by chance' }]
            },
            {
              frontBlocks: [{ type: 'text', text: 'Use serendipity in a sentence' }],
              backBlocks: [{ type: 'text', text: 'Meeting my mentor was pure serendipity.' }]
            }
          ]
        }
      }
    );

    expect(result.errors).toBeUndefined();
    const bit = result.data.createInfoBit;
    expect(bit.title).toBe('Serendipity');
    expect(bit.status).toBe('active');
    expect(bit.tags).toEqual(expect.arrayContaining(['english', 'vocab']));
    expect(bit.cards).toHaveLength(2);
    expect(bit.cards[0].status).toBe('active');
    expect(bit.cards[0].frontBlocks[0].text).toBe('Define serendipity');
  });

  it('rejects without auth', async () => {
    const result = await gql(
      `mutation ($input: CreateInfoBitInput!) {
        createInfoBit(input: $input) { infoBitId }
      }`,
      {
        input: {
          title: 'Test',
          categoryId,
          cards: [
            {
              frontBlocks: [{ type: 'text', text: 'Q' }],
              backBlocks: [{ type: 'text', text: 'A' }]
            }
          ]
        }
      }
    );

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/authentication required/i);
  });

  it('rejects with zero cards', async () => {
    const result = await gqlAuth(
      accessToken,
      `mutation ($input: CreateInfoBitInput!) {
        createInfoBit(input: $input) { infoBitId }
      }`,
      {
        input: {
          title: 'No cards',
          categoryId,
          cards: []
        }
      }
    );

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/at least one card/i);
  });

  it('rejects invalid category', async () => {
    const result = await gqlAuth(
      accessToken,
      `mutation ($input: CreateInfoBitInput!) {
        createInfoBit(input: $input) { infoBitId }
      }`,
      {
        input: {
          title: 'Bad cat',
          categoryId: '00000000-0000-0000-0000-000000000000',
          cards: [
            {
              frontBlocks: [{ type: 'text', text: 'Q' }],
              backBlocks: [{ type: 'text', text: 'A' }]
            }
          ]
        }
      }
    );

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/category not found/i);
  });

  it('works without optional tags and originalContent', async () => {
    const result = await gqlAuth(
      accessToken,
      `mutation ($input: CreateInfoBitInput!) {
        createInfoBit(input: $input) {
          infoBitId title tags
        }
      }`,
      {
        input: {
          title: 'No tags no content',
          categoryId,
          cards: [
            {
              frontBlocks: [{ type: 'text', text: 'Q' }],
              backBlocks: [{ type: 'text', text: 'A' }]
            }
          ]
        }
      }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.createInfoBit.tags).toEqual([]);
  });

  it('handles many cards', async () => {
    const cards = Array.from({ length: 5 }, (_, i) => ({
      frontBlocks: [{ type: 'text', text: `Question ${i + 1}` }],
      backBlocks: [{ type: 'text', text: `Answer ${i + 1}` }]
    }));

    const result = await gqlAuth(
      accessToken,
      `mutation ($input: CreateInfoBitInput!) {
        createInfoBit(input: $input) {
          infoBitId
          cards { cardId frontBlocks { text } }
        }
      }`,
      { input: { title: 'Five cards', categoryId, cards } }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.createInfoBit.cards).toHaveLength(5);
  });

  it('deduplicates tags by slug', async () => {
    const result = await gqlAuth(
      accessToken,
      `mutation ($input: CreateInfoBitInput!) {
        createInfoBit(input: $input) {
          infoBitId tags
        }
      }`,
      {
        input: {
          title: 'Dupe tags',
          categoryId,
          tags: ['English', 'english', 'ENGLISH'],
          cards: [
            {
              frontBlocks: [{ type: 'text', text: 'Q' }],
              backBlocks: [{ type: 'text', text: 'A' }]
            }
          ]
        }
      }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.createInfoBit.tags).toHaveLength(1);
  });

  it('records activity event in DB', async () => {
    const result = await gqlAuth(
      accessToken,
      `mutation ($input: CreateInfoBitInput!) {
        createInfoBit(input: $input) { infoBitId }
      }`,
      {
        input: {
          title: 'Activity check',
          categoryId,
          cards: [
            {
              frontBlocks: [{ type: 'text', text: 'Q' }],
              backBlocks: [{ type: 'text', text: 'A' }]
            }
          ]
        }
      }
    );

    expect(result.errors).toBeUndefined();
    const infoBitId = result.data.createInfoBit.infoBitId;
    const { models } = getModels();

    const events = await models.ActivityEvent.findAll({
      where: { info_bit_id: infoBitId, event_type: 'infobit.created' }
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload.card_count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 7. infoBits (requires auth)
// ─────────────────────────────────────────────────────────────
describe('infoBits', () => {
  let accessToken;
  let categoryId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'infobits-list@test.com' });
    accessToken = auth.accessToken;

    const catResult = await gqlAuth(
      accessToken,
      `query { categories { categoryId } }`
    );
    categoryId = catResult.data.categories[0].categoryId;
  });

  it('returns empty list for new user', async () => {
    const result = await gqlAuth(
      accessToken,
      `query { infoBits { edges { infoBitId title } nextCursor } }`
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.infoBits.edges).toEqual([]);
  });

  it('returns created infobits after creation', async () => {
    await gqlAuth(
      accessToken,
      `mutation ($input: CreateInfoBitInput!) {
        createInfoBit(input: $input) { infoBitId }
      }`,
      {
        input: {
          title: 'List Test',
          categoryId,
          cards: [
            {
              frontBlocks: [{ type: 'text', text: 'Q' }],
              backBlocks: [{ type: 'text', text: 'A' }]
            }
          ]
        }
      }
    );

    const result = await gqlAuth(
      accessToken,
      `query { infoBits { edges { infoBitId title status tags cards { cardId } } } }`
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.infoBits.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.data.infoBits.edges[0].title).toBe('List Test');
    expect(result.data.infoBits.edges[0].cards).toHaveLength(1);
  });

  it('rejects without auth', async () => {
    const result = await gql(`query { infoBits { edges { infoBitId } } }`);

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toMatch(/authentication required/i);
  });

  it('returns full card content (frontBlocks, backBlocks)', async () => {
    await gqlAuth(
      accessToken,
      `mutation ($input: CreateInfoBitInput!) {
        createInfoBit(input: $input) { infoBitId }
      }`,
      {
        input: {
          title: 'Content check',
          categoryId,
          cards: [
            {
              frontBlocks: [{ type: 'text', text: 'Front text' }],
              backBlocks: [{ type: 'text', text: 'Back text' }]
            }
          ]
        }
      }
    );

    const result = await gqlAuth(
      accessToken,
      `query { infoBits { edges {
        title
        cards { frontBlocks { type text } backBlocks { type text } }
      } } }`
    );

    expect(result.errors).toBeUndefined();
    const bit = result.data.infoBits.edges.find((b) => b.title === 'Content check');
    expect(bit).toBeDefined();
    expect(bit.cards[0].frontBlocks[0].text).toBe('Front text');
    expect(bit.cards[0].backBlocks[0].text).toBe('Back text');
  });

  it('returns newest infobits first', async () => {
    const result = await gqlAuth(
      accessToken,
      `query { infoBits { edges { title createdAt } } }`
    );

    expect(result.errors).toBeUndefined();
    const timestamps = result.data.infoBits.edges.map((b) => new Date(b.createdAt).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }
  });

  it('does not leak infobits between users', async () => {
    const otherAuth = await createTestUser({ email: 'other-user@test.com' });

    const result = await gqlAuth(
      otherAuth.accessToken,
      `query { infoBits { edges { infoBitId title } } }`
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.infoBits.edges).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 8. infoBit (single view)
// ─────────────────────────────────────────────────────────────
describe('infoBit (single)', () => {
  let accessToken, categoryId, infoBitId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'single-ib@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Single View', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    infoBitId = res.data.createInfoBit.infoBitId;
  });

  it('returns single InfoBit by ID', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { infoBit(infoBitId: $id) { infoBitId title cards { cardId } tags } }`,
      { id: infoBitId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.infoBit.infoBitId).toBe(infoBitId);
    expect(r.data.infoBit.title).toBe('Single View');
  });

  it('returns null for non-existent ID', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { infoBit(infoBitId: $id) { infoBitId } }`,
      { id: '00000000-0000-0000-0000-000000000000' }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.infoBit).toBeNull();
  });

  it('cannot see another users InfoBit', async () => {
    const other = await createTestUser({ email: 'other-single@test.com' });
    const r = await gqlAuth(other.accessToken,
      `query ($id: ID!) { infoBit(infoBitId: $id) { infoBitId } }`,
      { id: infoBitId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.infoBit).toBeNull();
  });

  it('rejects without auth', async () => {
    const r = await gql(
      `query ($id: ID!) { infoBit(infoBitId: $id) { infoBitId } }`,
      { id: infoBitId }
    );
    expect(r.errors).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 9. updateInfoBit
// ─────────────────────────────────────────────────────────────
describe('updateInfoBit', () => {
  let accessToken, categoryId, infoBitId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'update-ib@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Original Title', categoryId, tags: ['tagA', 'tagB'], cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    infoBitId = res.data.createInfoBit.infoBitId;
  });

  it('updates title in SQL + Mongo', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpdateInfoBitInput!) { updateInfoBit(input: $input) { title } }`,
      { input: { infoBitId, title: 'New Title' } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.updateInfoBit.title).toBe('New Title');

    const { mongoModels } = getModels();
    const doc = await mongoModels.InfoBitContent.findById(infoBitId).lean();
    expect(doc.title).toBe('New Title');
  });

  it('updates tags (add + remove)', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpdateInfoBitInput!) { updateInfoBit(input: $input) { tags } }`,
      { input: { infoBitId, tags: ['tagB', 'tagC'] } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.updateInfoBit.tags).toEqual(expect.arrayContaining(['tagB', 'tagC']));
    expect(r.data.updateInfoBit.tags).not.toContain('tagA');
  });

  it('partial update only title, tags unchanged', async () => {
    const before = await gqlAuth(accessToken,
      `query ($id: ID!) { infoBit(infoBitId: $id) { tags } }`,
      { id: infoBitId }
    );
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpdateInfoBitInput!) { updateInfoBit(input: $input) { title tags } }`,
      { input: { infoBitId, title: 'Only Title Changed' } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.updateInfoBit.title).toBe('Only Title Changed');
    expect(r.data.updateInfoBit.tags).toEqual(before.data.infoBit.tags);
  });

  it('rejects if not owner', async () => {
    const other = await createTestUser({ email: 'not-owner-update@test.com' });
    const r = await gqlAuth(other.accessToken,
      `mutation ($input: UpdateInfoBitInput!) { updateInfoBit(input: $input) { title } }`,
      { input: { infoBitId, title: 'Hacked' } }
    );
    expect(r.errors).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 10. archiveInfoBit / deleteInfoBit / markInfoBitMastered
// ─────────────────────────────────────────────────────────────
describe('InfoBit lifecycle', () => {
  let accessToken, categoryId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'lifecycle-ib@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;
  });

  async function makeInfoBit(title) {
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId status } }`,
      { input: { title, categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    return r.data.createInfoBit.infoBitId;
  }

  it('archiveInfoBit sets status to archived', async () => {
    const id = await makeInfoBit('To Archive');
    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!) { archiveInfoBit(infoBitId: $id) { status } }`,
      { id }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.archiveInfoBit.status).toBe('archived');
  });

  it('archived InfoBit excluded from infoBits list', async () => {
    const id = await makeInfoBit('Archive Exclude');
    await gqlAuth(accessToken,
      `mutation ($id: ID!) { archiveInfoBit(infoBitId: $id) { status } }`,
      { id }
    );
    const list = await gqlAuth(accessToken, `query { infoBits { edges { infoBitId } } }`);
    const ids = list.data.infoBits.edges.map(b => b.infoBitId);
    expect(ids).not.toContain(id);
  });

  it('archiveInfoBit creates activity event', async () => {
    const id = await makeInfoBit('Archive Event');
    await gqlAuth(accessToken,
      `mutation ($id: ID!) { archiveInfoBit(infoBitId: $id) { status } }`,
      { id }
    );
    const { models } = getModels();
    const events = await models.ActivityEvent.findAll({ where: { info_bit_id: id, event_type: 'infobit.archived' } });
    expect(events).toHaveLength(1);
  });

  it('deleteInfoBit sets status to deleted', async () => {
    const id = await makeInfoBit('To Delete');
    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!) { deleteInfoBit(infoBitId: $id) { status } }`,
      { id }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.deleteInfoBit.status).toBe('deleted');
  });

  it('deleted InfoBit excluded from infoBits list', async () => {
    const id = await makeInfoBit('Delete Exclude');
    await gqlAuth(accessToken,
      `mutation ($id: ID!) { deleteInfoBit(infoBitId: $id) { status } }`,
      { id }
    );
    const list = await gqlAuth(accessToken, `query { infoBits { edges { infoBitId } } }`);
    const ids = list.data.infoBits.edges.map(b => b.infoBitId);
    expect(ids).not.toContain(id);
  });

  it('markInfoBitMastered sets status to mastered', async () => {
    const id = await makeInfoBit('To Master');
    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!) { markInfoBitMastered(infoBitId: $id) { status } }`,
      { id }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.markInfoBitMastered.status).toBe('mastered');
  });

  it('rejects invalid transition: cannot delete already deleted', async () => {
    const id = await makeInfoBit('Double Delete');
    await gqlAuth(accessToken, `mutation ($id: ID!) { deleteInfoBit(infoBitId: $id) { status } }`, { id });
    const r = await gqlAuth(accessToken, `mutation ($id: ID!) { deleteInfoBit(infoBitId: $id) { status } }`, { id });
    expect(r.errors).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 11. Bulk ops + Filters
// ─────────────────────────────────────────────────────────────
describe('infoBits bulk + filters', () => {
  let accessToken, categoryId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'bulk-filter@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;
  });

  async function makeIB(title) {
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title, categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    return r.data.createInfoBit.infoBitId;
  }

  it('archiveInfoBits: bulk archives multiple', async () => {
    const id1 = await makeIB('BulkA1');
    const id2 = await makeIB('BulkA2');
    const r = await gqlAuth(accessToken,
      `mutation ($ids: [ID!]!) { archiveInfoBits(infoBitIds: $ids) { affectedCount infoBitIds } }`,
      { ids: [id1, id2] }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.archiveInfoBits.affectedCount).toBe(2);
  });

  it('archiveInfoBits: only affects owned InfoBits', async () => {
    const other = await createTestUser({ email: 'bulk-other@test.com' });
    const otherCats = await gqlAuth(other.accessToken, `query { categories { categoryId } }`);
    const otherCatId = otherCats.data.categories[0].categoryId;
    const res = await gqlAuth(other.accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'NotMine', categoryId: otherCatId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    const otherId = res.data.createInfoBit.infoBitId;
    const r = await gqlAuth(accessToken,
      `mutation ($ids: [ID!]!) { archiveInfoBits(infoBitIds: $ids) { affectedCount } }`,
      { ids: [otherId] }
    );
    expect(r.data.archiveInfoBits.affectedCount).toBe(0);
  });

  it('deleteInfoBits: bulk deletes multiple', async () => {
    const id1 = await makeIB('BulkD1');
    const id2 = await makeIB('BulkD2');
    const r = await gqlAuth(accessToken,
      `mutation ($ids: [ID!]!) { deleteInfoBits(infoBitIds: $ids) { affectedCount } }`,
      { ids: [id1, id2] }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.deleteInfoBits.affectedCount).toBe(2);
  });

  it('infoBits: filter by status', async () => {
    const id = await makeIB('StatusFilter');
    await gqlAuth(accessToken, `mutation ($id: ID!) { archiveInfoBit(infoBitId: $id) { status } }`, { id });
    const r = await gqlAuth(accessToken,
      `query { infoBits(status: archived) { edges { infoBitId status } } }`
    );
    expect(r.errors).toBeUndefined();
    const found = r.data.infoBits.edges.find(e => e.infoBitId === id);
    expect(found).toBeDefined();
    expect(found.status).toBe('archived');
  });

  it('infoBits: filter by categoryId', async () => {
    await makeIB('CatFilter');
    const r = await gqlAuth(accessToken,
      `query ($catId: ID!) { infoBits(categoryId: $catId) { edges { infoBitId } } }`,
      { catId: categoryId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.infoBits.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('infoBits: pagination with limit', async () => {
    await makeIB('Page1');
    await makeIB('Page2');
    await makeIB('Page3');
    const r = await gqlAuth(accessToken,
      `query { infoBits(limit: 2) { edges { infoBitId } nextCursor } }`
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.infoBits.edges.length).toBeLessThanOrEqual(2);
    expect(r.data.infoBits.nextCursor).toBeTruthy();
  });

  it('infoBits: pagination with cursor', async () => {
    const r1 = await gqlAuth(accessToken,
      `query { infoBits(limit: 1) { edges { infoBitId } nextCursor } }`
    );
    const cursor = r1.data.infoBits.nextCursor;
    expect(cursor).toBeTruthy();

    const r2 = await gqlAuth(accessToken,
      `query ($c: String) { infoBits(limit: 1, cursor: $c) { edges { infoBitId } nextCursor } }`,
      { c: cursor }
    );
    expect(r2.errors).toBeUndefined();
    expect(r2.data.infoBits.edges[0].infoBitId).not.toBe(r1.data.infoBits.edges[0].infoBitId);
  });
});

// ─────────────────────────────────────────────────────────────
// 12. Tags
// ─────────────────────────────────────────────────────────────
describe('tags', () => {
  let accessToken, categoryId, infoBitId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'tags-test@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId tags } }`,
      { input: { title: 'Tag Target', categoryId, tags: ['alpha', 'beta'], cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    infoBitId = res.data.createInfoBit.infoBitId;
  });

  it('tags: returns all users tags', async () => {
    const r = await gqlAuth(accessToken, `query { tags { tagId name slug isActive } }`);
    expect(r.errors).toBeUndefined();
    expect(r.data.tags.length).toBeGreaterThanOrEqual(2);
  });

  it('tags: returns empty for new user', async () => {
    const other = await createTestUser({ email: 'tags-empty@test.com' });
    const r = await gqlAuth(other.accessToken, `query { tags { tagId } }`);
    expect(r.errors).toBeUndefined();
    expect(r.data.tags).toEqual([]);
  });

  it('tags: rejects without auth', async () => {
    const r = await gql(`query { tags { tagId } }`);
    expect(r.errors).toBeDefined();
  });

  it('attachTags: adds tags to existing InfoBit', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!, $t: [String!]!) { attachTags(infoBitId: $id, tags: $t) { tags } }`,
      { id: infoBitId, t: ['gamma'] }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.attachTags.tags).toContain('gamma');
  });

  it('attachTags: creates new tags if needed', async () => {
    const tagsBefore = await gqlAuth(accessToken, `query { tags { name } }`);
    const names = tagsBefore.data.tags.map(t => t.name);
    await gqlAuth(accessToken,
      `mutation ($id: ID!, $t: [String!]!) { attachTags(infoBitId: $id, tags: $t) { tags } }`,
      { id: infoBitId, t: ['brandnew'] }
    );
    const tagsAfter = await gqlAuth(accessToken, `query { tags { name } }`);
    expect(tagsAfter.data.tags.map(t => t.name)).toContain('brandnew');
  });

  it('attachTags: updates Mongo tags array', async () => {
    const { mongoModels } = getModels();
    const doc = await mongoModels.InfoBitContent.findById(infoBitId).lean();
    expect(doc.tags).toContain('gamma');
  });

  it('detachTags: removes tags from InfoBit', async () => {
    const allTags = await gqlAuth(accessToken, `query { tags { tagId name } }`);
    const gammaTag = allTags.data.tags.find(t => t.name === 'gamma');

    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!, $tagIds: [ID!]!) { detachTags(infoBitId: $id, tagIds: $tagIds) { tags } }`,
      { id: infoBitId, tagIds: [gammaTag.tagId] }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.detachTags.tags).not.toContain('gamma');
  });

  it('detachTags: does not delete the tag itself', async () => {
    const allTags = await gqlAuth(accessToken, `query { tags { name } }`);
    expect(allTags.data.tags.map(t => t.name)).toContain('gamma');
  });

  it('detachTags: updates Mongo tags array', async () => {
    const { mongoModels } = getModels();
    const doc = await mongoModels.InfoBitContent.findById(infoBitId).lean();
    expect(doc.tags).not.toContain('gamma');
  });

  it('archiveTag: sets archived_at', async () => {
    const allTags = await gqlAuth(accessToken, `query { tags { tagId name } }`);
    const tag = allTags.data.tags.find(t => t.name === 'gamma');
    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!) { archiveTag(tagId: $id) { tagId isActive archivedAt } }`,
      { id: tag.tagId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.archiveTag.isActive).toBe(false);
    expect(r.data.archiveTag.archivedAt).toBeTruthy();
  });

  it('deleteTag: soft-deletes tag', async () => {
    const allTags = await gqlAuth(accessToken, `query { tags { tagId name } }`);
    const tag = allTags.data.tags.find(t => t.name === 'brandnew');
    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!) { deleteTag(tagId: $id) { tagId isActive } }`,
      { id: tag.tagId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.deleteTag.isActive).toBe(false);
  });

  it('archiveTags: bulk archives', async () => {
    const res1 = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'BulkTag', categoryId, tags: ['bulkA', 'bulkB'], cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    const allTags = await gqlAuth(accessToken, `query { tags { tagId name } }`);
    const bulkIds = allTags.data.tags.filter(t => ['bulkA', 'bulkB'].includes(t.name)).map(t => t.tagId);

    const r = await gqlAuth(accessToken,
      `mutation ($ids: [ID!]!) { archiveTags(tagIds: $ids) { affectedCount } }`,
      { ids: bulkIds }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.archiveTags.affectedCount).toBe(2);
  });

  it('tag isolation: user A cannot see user Bs tags', async () => {
    const other = await createTestUser({ email: 'tags-isolated@test.com' });
    const r = await gqlAuth(other.accessToken, `query { tags { tagId } }`);
    expect(r.data.tags).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 13. Cards
// ─────────────────────────────────────────────────────────────
describe('cards', () => {
  let accessToken, categoryId, infoBitId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'cards-test@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'Card Target', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q1' }], backBlocks: [{ type: 'text', text: 'A1' }] }] } }
    );
    infoBitId = res.data.createInfoBit.infoBitId;
  });

  it('addCard: adds card to existing InfoBit', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!, $input: CreateCardInput!) { addCard(infoBitId: $id, input: $input) { cardId status frontBlocks { text } } }`,
      { id: infoBitId, input: { frontBlocks: [{ type: 'text', text: 'Q2' }], backBlocks: [{ type: 'text', text: 'A2' }] } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.addCard.cardId).toBeTruthy();
    expect(r.data.addCard.status).toBe('active');
  });

  it('addCard: Mongo number_of_cards incremented', async () => {
    const { mongoModels } = getModels();
    const doc = await mongoModels.InfoBitContent.findById(infoBitId).lean();
    expect(doc.cards.length).toBe(2);
    expect(doc.number_of_cards).toBe(2);
  });

  it('addCard: rejects if InfoBit not owned', async () => {
    const other = await createTestUser({ email: 'cards-other@test.com' });
    const r = await gqlAuth(other.accessToken,
      `mutation ($id: ID!, $input: CreateCardInput!) { addCard(infoBitId: $id, input: $input) { cardId } }`,
      { id: infoBitId, input: { frontBlocks: [{ type: 'text', text: 'Hack' }], backBlocks: [{ type: 'text', text: 'Nope' }] } }
    );
    expect(r.errors).toBeDefined();
  });

  it('updateCardContent: updates front/back blocks', async () => {
    const ib = await gqlAuth(accessToken,
      `query ($id: ID!) { infoBit(infoBitId: $id) { cards { cardId } } }`, { id: infoBitId }
    );
    const cardId = ib.data.infoBit.cards[0].cardId;

    const r = await gqlAuth(accessToken,
      `mutation ($input: UpdateCardInput!) { updateCardContent(input: $input) { cardId frontBlocks { text } backBlocks { text } } }`,
      { input: { cardId, frontBlocks: [{ type: 'text', text: 'Updated Q' }], backBlocks: [{ type: 'text', text: 'Updated A' }] } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.updateCardContent.frontBlocks[0].text).toBe('Updated Q');
    expect(r.data.updateCardContent.backBlocks[0].text).toBe('Updated A');
  });

  it('updateCardContent: increments content_version', async () => {
    const { models } = getModels();
    const ib = await gqlAuth(accessToken,
      `query ($id: ID!) { infoBit(infoBitId: $id) { cards { cardId } } }`, { id: infoBitId }
    );
    const cardId = ib.data.infoBit.cards[0].cardId;
    const card = await models.Card.findByPk(cardId);
    expect(card.content_version).toBeGreaterThanOrEqual(2);
  });

  it('updateCardContent: logs activity event', async () => {
    const { models } = getModels();
    const ib = await gqlAuth(accessToken,
      `query ($id: ID!) { infoBit(infoBitId: $id) { cards { cardId } } }`, { id: infoBitId }
    );
    const cardId = ib.data.infoBit.cards[0].cardId;
    const events = await models.ActivityEvent.findAll({ where: { card_id: cardId, event_type: 'card.content_updated' } });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('archiveCard: sets status to archived', async () => {
    const addRes = await gqlAuth(accessToken,
      `mutation ($id: ID!, $input: CreateCardInput!) { addCard(infoBitId: $id, input: $input) { cardId } }`,
      { id: infoBitId, input: { frontBlocks: [{ type: 'text', text: 'Arc Q' }], backBlocks: [{ type: 'text', text: 'Arc A' }] } }
    );
    const cardId = addRes.data.addCard.cardId;

    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!) { archiveCard(cardId: $id) { cardId status } }`,
      { id: cardId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.archiveCard.status).toBe('archived');
  });

  it('deleteCard: soft-deletes card', async () => {
    const addRes = await gqlAuth(accessToken,
      `mutation ($id: ID!, $input: CreateCardInput!) { addCard(infoBitId: $id, input: $input) { cardId } }`,
      { id: infoBitId, input: { frontBlocks: [{ type: 'text', text: 'Del Q' }], backBlocks: [{ type: 'text', text: 'Del A' }] } }
    );
    const cardId = addRes.data.addCard.cardId;

    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!) { deleteCard(cardId: $id) { cardId status } }`,
      { id: cardId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.deleteCard.status).toBe('deleted');
  });

  it('archiveCards: bulk archives', async () => {
    const a1 = await gqlAuth(accessToken,
      `mutation ($id: ID!, $input: CreateCardInput!) { addCard(infoBitId: $id, input: $input) { cardId } }`,
      { id: infoBitId, input: { frontBlocks: [{ type: 'text', text: 'B1' }], backBlocks: [{ type: 'text', text: 'B1' }] } }
    );
    const a2 = await gqlAuth(accessToken,
      `mutation ($id: ID!, $input: CreateCardInput!) { addCard(infoBitId: $id, input: $input) { cardId } }`,
      { id: infoBitId, input: { frontBlocks: [{ type: 'text', text: 'B2' }], backBlocks: [{ type: 'text', text: 'B2' }] } }
    );

    const r = await gqlAuth(accessToken,
      `mutation ($ids: [ID!]!) { archiveCards(cardIds: $ids) { affectedCount } }`,
      { ids: [a1.data.addCard.cardId, a2.data.addCard.cardId] }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.archiveCards.affectedCount).toBe(2);
  });

  it('deleteCards: bulk deletes', async () => {
    const a1 = await gqlAuth(accessToken,
      `mutation ($id: ID!, $input: CreateCardInput!) { addCard(infoBitId: $id, input: $input) { cardId } }`,
      { id: infoBitId, input: { frontBlocks: [{ type: 'text', text: 'D1' }], backBlocks: [{ type: 'text', text: 'D1' }] } }
    );
    const a2 = await gqlAuth(accessToken,
      `mutation ($id: ID!, $input: CreateCardInput!) { addCard(infoBitId: $id, input: $input) { cardId } }`,
      { id: infoBitId, input: { frontBlocks: [{ type: 'text', text: 'D2' }], backBlocks: [{ type: 'text', text: 'D2' }] } }
    );

    const r = await gqlAuth(accessToken,
      `mutation ($ids: [ID!]!) { deleteCards(cardIds: $ids) { affectedCount } }`,
      { ids: [a1.data.addCard.cardId, a2.data.addCard.cardId] }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.deleteCards.affectedCount).toBe(2);
  });

  it('card isolation: cannot modify another users cards', async () => {
    const other = await createTestUser({ email: 'card-iso@test.com' });
    const ib = await gqlAuth(accessToken,
      `query ($id: ID!) { infoBit(infoBitId: $id) { cards { cardId } } }`, { id: infoBitId }
    );
    const cardId = ib.data.infoBit.cards[0].cardId;

    const r = await gqlAuth(other.accessToken,
      `mutation ($input: UpdateCardInput!) { updateCardContent(input: $input) { cardId } }`,
      { input: { cardId, frontBlocks: [{ type: 'text', text: 'Hacked' }] } }
    );
    expect(r.errors).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 14. FSRS Review Flow
// ─────────────────────────────────────────────────────────────
describe('FSRS review flow', () => {
  let accessToken, categoryId, infoBitId, cardId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'fsrs-test@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'FSRS Target', categoryId, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q1' }], backBlocks: [{ type: 'text', text: 'A1' }] },
        { frontBlocks: [{ type: 'text', text: 'Q2' }], backBlocks: [{ type: 'text', text: 'A2' }] }
      ] } }
    );
    infoBitId = res.data.createInfoBit.infoBitId;
    cardId = res.data.createInfoBit.cards[0].cardId;
  });

  it('createInfoBit now creates fsrs_card_states row', async () => {
    const { models } = getModels();
    const state = await models.FSRSCardState.findByPk(infoBitId);
    expect(state).not.toBeNull();
    expect(state.state).toBe(0);
    expect(state.reps).toBe(0);
  });

  it('dueInfoBits: returns due InfoBits', async () => {
    const r = await gqlAuth(accessToken, `query { dueInfoBits { infoBitId title dueAt } }`);
    expect(r.errors).toBeUndefined();
    const found = r.data.dueInfoBits.find(d => d.infoBitId === infoBitId);
    expect(found).toBeDefined();
    expect(found.title).toBe('FSRS Target');
  });

  it('dueInfoBits: excludes archived InfoBits', async () => {
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Archived Due', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    const archId = res.data.createInfoBit.infoBitId;
    await gqlAuth(accessToken, `mutation ($id: ID!) { archiveInfoBit(infoBitId: $id) { status } }`, { id: archId });

    const r = await gqlAuth(accessToken, `query { dueInfoBits { infoBitId } }`);
    const ids = r.data.dueInfoBits.map(d => d.infoBitId);
    expect(ids).not.toContain(archId);
  });

  it('dueInfoBits: rejects without auth', async () => {
    const r = await gql(`query { dueInfoBits { infoBitId } }`);
    expect(r.errors).toBeDefined();
  });

  it('nextReviewCard: returns a card for a due InfoBit', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { nextReviewCard(infoBitId: $id) { infoBitId card { cardId frontBlocks { text } } dueAt allowedRatings } }`,
      { id: infoBitId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.nextReviewCard.card.cardId).toBeTruthy();
    expect(r.data.nextReviewCard.allowedRatings).toEqual(['AGAIN', 'HARD', 'GOOD', 'EASY']);
  });

  it('submitReview: updates FSRS state', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: SubmitReviewInput!) { submitReview(input: $input) { reviewEventId nextDueAt stateAfter } }`,
      { input: { infoBitId, cardId, rating: 'GOOD', responseMs: 3000 } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.submitReview.reviewEventId).toBeTruthy();
    expect(r.data.submitReview.nextDueAt).toBeTruthy();
    expect(r.data.submitReview.stateAfter).toBeTruthy();
  });

  it('submitReview: creates review log', async () => {
    const { models } = getModels();
    const logs = await models.FSRSReviewLog.findAll({ where: { info_bit_id: infoBitId } });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].state_before).toBeTruthy();
    expect(logs[0].state_after).toBeTruthy();
  });

  it('submitReview: updates due_at on InfoBit', async () => {
    const { models } = getModels();
    const ib = await models.InfoBit.findByPk(infoBitId);
    expect(ib.due_at).not.toBeNull();
  });

  it('submitReview: updates card last_reviewed_at', async () => {
    const { models } = getModels();
    const card = await models.Card.findByPk(cardId);
    expect(card.last_reviewed_at).not.toBeNull();
  });

  it('submitReview: updates Mongo rotation', async () => {
    const { mongoModels } = getModels();
    const doc = await mongoModels.InfoBitContent.findById(infoBitId).lean();
    expect(doc.rotation.last_presented_card_id).toBe(cardId);
  });

  it('submitReview: rejects invalid InfoBit', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: SubmitReviewInput!) { submitReview(input: $input) { reviewEventId } }`,
      { input: { infoBitId: '00000000-0000-0000-0000-000000000000', cardId, rating: 'GOOD' } }
    );
    expect(r.errors).toBeDefined();
  });

  it('submitReview: rejects if InfoBit not owned', async () => {
    const other = await createTestUser({ email: 'fsrs-other@test.com' });
    const r = await gqlAuth(other.accessToken,
      `mutation ($input: SubmitReviewInput!) { submitReview(input: $input) { reviewEventId } }`,
      { input: { infoBitId, cardId, rating: 'GOOD' } }
    );
    expect(r.errors).toBeDefined();
  });

  it('submitReview: AGAIN keeps card in learning (due soon)', async () => {
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'AGAIN Test', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'AQ' }], backBlocks: [{ type: 'text', text: 'AA' }] }] } }
    );
    const id = res.data.createInfoBit.infoBitId;
    const cid = res.data.createInfoBit.cards[0].cardId;

    const r = await gqlAuth(accessToken,
      `mutation ($input: SubmitReviewInput!) { submitReview(input: $input) { reviewEventId nextDueAt stateAfter } }`,
      { input: { infoBitId: id, cardId: cid, rating: 'AGAIN' } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.submitReview.nextDueAt).toBeTruthy();
    const nextDue = new Date(r.data.submitReview.nextDueAt);
    expect(nextDue.getTime()).toBeLessThan(Date.now() + 24 * 60 * 60 * 1000);
  });

  it('submitReview: HARD produces shorter interval than EASY', async () => {
    const makeAndReview = async (title, rating) => {
      const res = await gqlAuth(accessToken,
        `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
        { input: { title, categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
      );
      const id = res.data.createInfoBit.infoBitId;
      const cid = res.data.createInfoBit.cards[0].cardId;
      const r = await gqlAuth(accessToken,
        `mutation ($input: SubmitReviewInput!) { submitReview(input: $input) { nextDueAt } }`,
        { input: { infoBitId: id, cardId: cid, rating } }
      );
      return new Date(r.data.submitReview.nextDueAt).getTime();
    };

    const hardDue = await makeAndReview('Hard Compare', 'HARD');
    const easyDue = await makeAndReview('Easy Compare', 'EASY');
    expect(hardDue).toBeLessThan(easyDue);
  });

  it('submitReview: uses effective scheduler policy params', async () => {
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'Policy Review', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'PQ' }], backBlocks: [{ type: 'text', text: 'PA' }] }] } }
    );
    const ibId = res.data.createInfoBit.infoBitId;
    const cId = res.data.createInfoBit.cards[0].cardId;

    await gqlAuth(accessToken,
      `mutation ($input: UpsertSchedulerPolicyInput!) { upsertSchedulerPolicy(input: $input) { policyId } }`,
      { input: { scope: 'INFOBIT', infoBitId: ibId, algorithmKey: 'fsrs', params: { request_retention: 0.99 }, applyMode: 'FUTURE_ONLY' } }
    );

    const r = await gqlAuth(accessToken,
      `mutation ($input: SubmitReviewInput!) { submitReview(input: $input) { reviewEventId nextDueAt } }`,
      { input: { infoBitId: ibId, cardId: cId, rating: 'GOOD' } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.submitReview.reviewEventId).toBeTruthy();

    const { models } = getModels();
    const log = await models.FSRSReviewLog.findOne({ where: { info_bit_id: ibId }, order: [['reviewed_at', 'DESC']] });
    expect(log.effective_policy_scope).toBe('infobit');
    expect(log.effective_params_snapshot.request_retention).toBe(0.99);
  });

  it('full review cycle: create -> due -> review -> not immediately due', async () => {
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'Cycle Test', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'CQ' }], backBlocks: [{ type: 'text', text: 'CA' }] }] } }
    );
    const id = res.data.createInfoBit.infoBitId;
    const cid = res.data.createInfoBit.cards[0].cardId;

    const due1 = await gqlAuth(accessToken, `query { dueInfoBits { infoBitId } }`);
    expect(due1.data.dueInfoBits.map(d => d.infoBitId)).toContain(id);

    await gqlAuth(accessToken,
      `mutation ($input: SubmitReviewInput!) { submitReview(input: $input) { reviewEventId nextDueAt } }`,
      { input: { infoBitId: id, cardId: cid, rating: 'EASY' } }
    );

    const due2 = await gqlAuth(accessToken, `query { dueInfoBits { infoBitId } }`);
    expect(due2.data.dueInfoBits.map(d => d.infoBitId)).not.toContain(id);
  });

  it('nextReviewCard: includes ratingPreviews for all 4 ratings', async () => {
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'Preview Embed Test', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'PQ' }], backBlocks: [{ type: 'text', text: 'PA' }] }] } }
    );
    const id = res.data.createInfoBit.infoBitId;

    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { nextReviewCard(infoBitId: $id) { infoBitId allowedRatings ratingPreviews { rating nextDueAt scheduledDays newStability newDifficulty newState } } }`,
      { id }
    );
    expect(r.errors).toBeUndefined();
    const previews = r.data.nextReviewCard.ratingPreviews;
    expect(previews).toHaveLength(4);
    expect(previews.map(p => p.rating)).toEqual(['AGAIN', 'HARD', 'GOOD', 'EASY']);
    previews.forEach(p => {
      expect(p.nextDueAt).toBeTruthy();
      expect(typeof p.scheduledDays).toBe('number');
      expect(typeof p.newStability).toBe('number');
      expect(typeof p.newDifficulty).toBe('number');
      expect(typeof p.newState).toBe('number');
    });
  });

  it('reviewSchedulePreview: returns previews for a due InfoBit', async () => {
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Standalone Preview', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'SPQ' }], backBlocks: [{ type: 'text', text: 'SPA' }] }] } }
    );
    const id = res.data.createInfoBit.infoBitId;

    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { reviewSchedulePreview(infoBitId: $id) { rating nextDueAt scheduledDays newStability newDifficulty newState } }`,
      { id }
    );
    expect(r.errors).toBeUndefined();
    const previews = r.data.reviewSchedulePreview;
    expect(previews).toHaveLength(4);
    expect(previews.map(p => p.rating)).toEqual(['AGAIN', 'HARD', 'GOOD', 'EASY']);
    const dueTimes = previews.map(p => new Date(p.nextDueAt).getTime());
    expect(dueTimes[0]).toBeLessThanOrEqual(dueTimes[1]);
    expect(dueTimes[1]).toBeLessThanOrEqual(dueTimes[2]);
    expect(dueTimes[2]).toBeLessThanOrEqual(dueTimes[3]);
  });

  it('reviewSchedulePreview: rejects without auth', async () => {
    const r = await gql(
      `query ($id: ID!) { reviewSchedulePreview(infoBitId: $id) { rating } }`,
      { id: infoBitId }
    );
    expect(r.errors).toBeDefined();
  });

  it('reviewSchedulePreview: 404 for unknown InfoBit', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { reviewSchedulePreview(infoBitId: $id) { rating } }`,
      { id: '00000000-0000-0000-0000-000000000000' }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────
// 15. Scheduler Policy
// ─────────────────────────────────────────────────────────────
describe('scheduler policy', () => {
  let accessToken, categoryId, infoBitId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'sched-test@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'Sched Target', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    infoBitId = res.data.createInfoBit.infoBitId;
  });

  it('schedulerPolicyPreview: returns system default when no overrides', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { schedulerPolicyPreview(infoBitId: $id) { scope algorithmKey params sourcePolicyId } }`,
      { id: infoBitId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.schedulerPolicyPreview.scope).toBe('USER_DEFAULT');
    expect(r.data.schedulerPolicyPreview.algorithmKey).toBe('fsrs');
    expect(r.data.schedulerPolicyPreview.sourcePolicyId).toBeNull();
  });

  it('upsertSchedulerPolicy: creates new user-default policy', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpsertSchedulerPolicyInput!) { upsertSchedulerPolicy(input: $input) { policyId scope algorithmKey params isActive applyMode } }`,
      { input: { scope: 'USER_DEFAULT', algorithmKey: 'fsrs', params: { request_retention: 0.85 }, applyMode: 'FUTURE_ONLY' } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.upsertSchedulerPolicy.policyId).toBeTruthy();
    expect(r.data.upsertSchedulerPolicy.scope).toBe('USER_DEFAULT');
    expect(r.data.upsertSchedulerPolicy.params.request_retention).toBe(0.85);
  });

  it('schedulerPolicyPreview: returns user override when set', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { schedulerPolicyPreview(infoBitId: $id) { scope sourcePolicyId } }`,
      { id: infoBitId }
    );
    expect(r.data.schedulerPolicyPreview.scope).toBe('USER_DEFAULT');
    expect(r.data.schedulerPolicyPreview.sourcePolicyId).toBeTruthy();
  });

  it('upsertSchedulerPolicy: InfoBit override beats user default', async () => {
    await gqlAuth(accessToken,
      `mutation ($input: UpsertSchedulerPolicyInput!) { upsertSchedulerPolicy(input: $input) { policyId } }`,
      { input: { scope: 'INFOBIT', infoBitId, algorithmKey: 'fsrs', params: { request_retention: 0.95 }, applyMode: 'FUTURE_ONLY' } }
    );

    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { schedulerPolicyPreview(infoBitId: $id) { scope params } }`,
      { id: infoBitId }
    );
    expect(r.data.schedulerPolicyPreview.scope).toBe('INFOBIT');
    expect(r.data.schedulerPolicyPreview.params.request_retention).toBe(0.95);
  });

  it('upsertSchedulerPolicy: updates existing policy', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpsertSchedulerPolicyInput!) { upsertSchedulerPolicy(input: $input) { policyId params } }`,
      { input: { scope: 'INFOBIT', infoBitId, algorithmKey: 'fsrs', params: { request_retention: 0.80 }, applyMode: 'FUTURE_ONLY' } }
    );
    expect(r.data.upsertSchedulerPolicy.params.request_retention).toBe(0.80);
  });

  it('removeSchedulerPolicy: removes policy', async () => {
    const create = await gqlAuth(accessToken,
      `mutation ($input: UpsertSchedulerPolicyInput!) { upsertSchedulerPolicy(input: $input) { policyId } }`,
      { input: { scope: 'CATEGORY', categoryId, algorithmKey: 'fsrs', params: { request_retention: 0.9 }, applyMode: 'FUTURE_ONLY' } }
    );
    const policyId = create.data.upsertSchedulerPolicy.policyId;

    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!) { removeSchedulerPolicy(policyId: $id) }`,
      { id: policyId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.removeSchedulerPolicy).toBe(true);
  });

  it('schedulerPolicyPreview: category override beats user default', async () => {
    await gqlAuth(accessToken,
      `mutation ($input: UpsertSchedulerPolicyInput!) { upsertSchedulerPolicy(input: $input) { policyId } }`,
      { input: { scope: 'CATEGORY', categoryId, algorithmKey: 'fsrs', params: { request_retention: 0.88 }, applyMode: 'FUTURE_ONLY' } }
    );

    const newIb = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Cat Policy Test', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    const newIbId = newIb.data.createInfoBit.infoBitId;

    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { schedulerPolicyPreview(infoBitId: $id) { scope params sourcePolicyId } }`,
      { id: newIbId }
    );
    expect(r.data.schedulerPolicyPreview.scope).toBe('CATEGORY');
    expect(r.data.schedulerPolicyPreview.params.request_retention).toBe(0.88);
    expect(r.data.schedulerPolicyPreview.sourcePolicyId).toBeTruthy();
  });

  it('recalculateSchedules: replays review history', async () => {
    const cardId = (await gqlAuth(accessToken,
      `query ($id: ID!) { infoBit(infoBitId: $id) { cards { cardId } } }`, { id: infoBitId }
    )).data.infoBit.cards[0].cardId;

    await gqlAuth(accessToken,
      `mutation ($input: SubmitReviewInput!) { submitReview(input: $input) { reviewEventId } }`,
      { input: { infoBitId, cardId, rating: 'GOOD' } }
    );

    const r = await gqlAuth(accessToken,
      `mutation ($scope: SchedulerScope!, $id: ID) { recalculateSchedules(scope: $scope, infoBitId: $id) }`,
      { scope: 'INFOBIT', id: infoBitId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.recalculateSchedules).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 16. Flags
// ─────────────────────────────────────────────────────────────
describe('flags', () => {
  let accessToken, categoryId, infoBitId, cardId, tagId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'flags-test@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'Flag Target', categoryId, tags: ['flagtag'], cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    infoBitId = res.data.createInfoBit.infoBitId;
    cardId = res.data.createInfoBit.cards[0].cardId;

    const tagRes = await gqlAuth(accessToken, `query { tags { tagId name } }`);
    tagId = tagRes.data.tags.find(t => t.name === 'flagtag').tagId;
  });

  it('flags: returns empty for new user', async () => {
    const other = await createTestUser({ email: 'flags-empty@test.com' });
    const r = await gqlAuth(other.accessToken, `query { flags { flagId } }`);
    expect(r.errors).toBeUndefined();
    expect(r.data.flags).toEqual([]);
  });

  it('createFlag: flags an InfoBit', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateFlagInput!) { createFlag(input: $input) { flagId entityType entityId flagType status } }`,
      { input: { entityType: 'INFOBIT', entityId: infoBitId, flagType: 'NEEDS_EDIT', note: 'fix spelling' } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.createFlag.entityType).toBe('INFOBIT');
    expect(r.data.createFlag.flagType).toBe('NEEDS_EDIT');
    expect(r.data.createFlag.status).toBe('OPEN');
  });

  it('createFlag: flags a card and sets card.flagged_at', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateFlagInput!) { createFlag(input: $input) { flagId entityType } }`,
      { input: { entityType: 'CARD', entityId: cardId, flagType: 'LOW_QUALITY' } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.createFlag.entityType).toBe('CARD');

    const { models } = getModels();
    const card = await models.Card.findByPk(cardId, { paranoid: false });
    expect(card.flagged_at).not.toBeNull();
  });

  it('createFlag: flags a tag', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateFlagInput!) { createFlag(input: $input) { flagId entityType } }`,
      { input: { entityType: 'TAG', entityId: tagId, flagType: 'OTHER' } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.createFlag.entityType).toBe('TAG');
  });

  it('createFlag: rejects invalid entity', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateFlagInput!) { createFlag(input: $input) { flagId } }`,
      { input: { entityType: 'INFOBIT', entityId: '00000000-0000-0000-0000-000000000000', flagType: 'OTHER' } }
    );
    expect(r.errors).toBeDefined();
  });

  it('flags: returns created flags', async () => {
    const r = await gqlAuth(accessToken, `query { flags { flagId entityType status } }`);
    expect(r.errors).toBeUndefined();
    expect(r.data.flags.length).toBeGreaterThanOrEqual(3);
  });

  it('flags: filter by status', async () => {
    const r = await gqlAuth(accessToken, `query { flags(status: OPEN) { flagId status } }`);
    r.data.flags.forEach(f => expect(f.status).toBe('OPEN'));
  });

  it('flags: filter by entityType', async () => {
    const r = await gqlAuth(accessToken, `query { flags(entityType: CARD) { flagId entityType } }`);
    r.data.flags.forEach(f => expect(f.entityType).toBe('CARD'));
  });

  it('resolveFlag: marks flag resolved', async () => {
    const all = await gqlAuth(accessToken, `query { flags(status: OPEN) { flagId } }`);
    const flagId = all.data.flags[0].flagId;

    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!) { resolveFlag(flagId: $id) { flagId status resolvedAt } }`,
      { id: flagId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.resolveFlag.status).toBe('RESOLVED');
    expect(r.data.resolveFlag.resolvedAt).toBeTruthy();
  });

  it('resolveFlag: rejects if not flag owner', async () => {
    const all = await gqlAuth(accessToken, `query { flags(status: OPEN) { flagId } }`);
    if (all.data.flags.length === 0) return;
    const flagId = all.data.flags[0].flagId;

    const other = await createTestUser({ email: 'flag-other@test.com' });
    const r = await gqlAuth(other.accessToken,
      `mutation ($id: ID!) { resolveFlag(flagId: $id) { flagId } }`,
      { id: flagId }
    );
    expect(r.errors).toBeDefined();
  });

  it('flag isolation: user A cannot see user Bs flags', async () => {
    const other = await createTestUser({ email: 'flag-iso@test.com' });
    const r = await gqlAuth(other.accessToken, `query { flags { flagId } }`);
    expect(r.data.flags).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 17. Dashboard
// ─────────────────────────────────────────────────────────────
describe('dashboardInfoBits', () => {
  let accessToken, categoryId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'dash-test@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;
  });

  it('returns structure for new user', async () => {
    const r = await gqlAuth(accessToken,
      `query { dashboardInfoBits { flaggedInfoBits { infoBitId } flaggedCards { cardId } sectionsByTag { tag { tagId } infoBits { infoBitId } } } }`
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.dashboardInfoBits.flaggedInfoBits).toEqual([]);
    expect(r.data.dashboardInfoBits.flaggedCards).toEqual([]);
    expect(r.data.dashboardInfoBits.sectionsByTag).toEqual([]);
  });

  it('shows flagged InfoBits', async () => {
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Dash Flagged', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    const ibId = res.data.createInfoBit.infoBitId;

    await gqlAuth(accessToken,
      `mutation ($input: CreateFlagInput!) { createFlag(input: $input) { flagId } }`,
      { input: { entityType: 'INFOBIT', entityId: ibId, flagType: 'NEEDS_EDIT' } }
    );

    const r = await gqlAuth(accessToken,
      `query { dashboardInfoBits { flaggedInfoBits { infoBitId title } } }`
    );
    const found = r.data.dashboardInfoBits.flaggedInfoBits.find(ib => ib.infoBitId === ibId);
    expect(found).toBeDefined();
  });

  it('shows flagged cards', async () => {
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'Dash Card Flag', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'DQ' }], backBlocks: [{ type: 'text', text: 'DA' }] }] } }
    );
    const cardId = res.data.createInfoBit.cards[0].cardId;

    await gqlAuth(accessToken,
      `mutation ($input: CreateFlagInput!) { createFlag(input: $input) { flagId } }`,
      { input: { entityType: 'CARD', entityId: cardId, flagType: 'LOW_QUALITY' } }
    );

    const r = await gqlAuth(accessToken,
      `query { dashboardInfoBits { flaggedCards { cardId frontBlocks { text } } } }`
    );
    const found = r.data.dashboardInfoBits.flaggedCards.find(c => c.cardId === cardId);
    expect(found).toBeDefined();
  });

  it('groups by tag', async () => {
    await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Dash Tag Group', categoryId, tags: ['dashboard-tag'], cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );

    const r = await gqlAuth(accessToken,
      `query { dashboardInfoBits { sectionsByTag { tag { name } infoBits { infoBitId } } } }`
    );
    expect(r.errors).toBeUndefined();
    const section = r.data.dashboardInfoBits.sectionsByTag.find(s => s.tag.name === 'dashboard-tag');
    expect(section).toBeDefined();
    expect(section.infoBits.length).toBeGreaterThanOrEqual(1);
  });

  it('respects limits', async () => {
    const r = await gqlAuth(accessToken,
      `query { dashboardInfoBits(limitPerTag: 1, tagLimit: 1) { sectionsByTag { tag { name } infoBits { infoBitId } } } }`
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.dashboardInfoBits.sectionsByTag.length).toBeLessThanOrEqual(1);
    if (r.data.dashboardInfoBits.sectionsByTag.length > 0) {
      expect(r.data.dashboardInfoBits.sectionsByTag[0].infoBits.length).toBeLessThanOrEqual(1);
    }
  });

  it('rejects without auth', async () => {
    const r = await gql(`query { dashboardInfoBits { flaggedInfoBits { infoBitId } } }`);
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/authentication required/i);
  });
});

// ─────────────────────────────────────────────────────────────
// 18. Data consistency: SQL + Mongo after createInfoBit
// ─────────────────────────────────────────────────────────────
describe('data consistency', () => {
  it('writes to both Postgres and Mongo', async () => {
    const auth = await createTestUser({ email: 'consistency@test.com' });

    const catResult = await gqlAuth(
      auth.accessToken,
      `query { categories { categoryId } }`
    );
    const categoryId = catResult.data.categories[0].categoryId;

    const createResult = await gqlAuth(
      auth.accessToken,
      `mutation ($input: CreateInfoBitInput!) {
        createInfoBit(input: $input) {
          infoBitId
          cards { cardId }
        }
      }`,
      {
        input: {
          title: 'Consistency Check',
          categoryId,
          tags: ['test-tag'],
          cards: [
            {
              frontBlocks: [{ type: 'text', text: 'Q' }],
              backBlocks: [{ type: 'text', text: 'A' }]
            }
          ]
        }
      }
    );

    expect(createResult.errors).toBeUndefined();
    const infoBitId = createResult.data.createInfoBit.infoBitId;
    const cardId = createResult.data.createInfoBit.cards[0].cardId;

    // Check Postgres
    const { models, mongoModels } = require('./setup').getModels();

    const sqlInfoBit = await models.InfoBit.findByPk(infoBitId);
    expect(sqlInfoBit).not.toBeNull();
    expect(sqlInfoBit.status).toBe('active');

    const sqlCards = await models.Card.findAll({ where: { info_bit_id: infoBitId } });
    expect(sqlCards).toHaveLength(1);
    expect(sqlCards[0].card_id).toBe(cardId);

    const sqlTags = await models.Tag.findAll({
      where: { user_id: sqlInfoBit.user_id, slug: 'test-tag' }
    });
    expect(sqlTags.length).toBeGreaterThanOrEqual(1);

    const sqlJoinRows = await models.InfoBitTag.findAll({
      where: { info_bit_id: infoBitId }
    });
    expect(sqlJoinRows).toHaveLength(1);

    // Check Mongo
    const mongoDoc = await mongoModels.InfoBitContent.findById(infoBitId).lean();
    expect(mongoDoc).not.toBeNull();
    expect(mongoDoc.title).toBe('Consistency Check');
    expect(mongoDoc.cards).toHaveLength(1);
    expect(mongoDoc.cards[0].card_id).toBe(cardId);
    expect(mongoDoc.tags).toEqual(['test-tag']);
    expect(mongoDoc.original_content).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 19. Generation policies
// ─────────────────────────────────────────────────────────────
describe('generation policies', () => {
  let accessToken, categoryId, infoBitId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'gen-policy@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'GenPolicy Target', categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    infoBitId = res.data.createInfoBit.infoBitId;
  });

  it('generationPolicyPreview: returns system default when no overrides', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { generationPolicyPreview(infoBitId: $id) { scope config sourcePolicyId } }`,
      { id: infoBitId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.generationPolicyPreview.scope).toBe('USER_DEFAULT');
    expect(r.data.generationPolicyPreview.sourcePolicyId).toBeNull();
    expect(r.data.generationPolicyPreview.config.targetCardCount).toBe(3);
  });

  it('upsertGenerationPolicy: creates user default policy', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId scope config isActive } }`,
      { input: { scope: 'USER_DEFAULT', config: { targetCardCount: 5, creativityLevel: 3, requiredCardStyles: ['direct_qa', 'cloze_contextual'] } } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.upsertGenerationPolicy.scope).toBe('USER_DEFAULT');
    expect(r.data.upsertGenerationPolicy.config.targetCardCount).toBe(5);
    expect(r.data.upsertGenerationPolicy.isActive).toBe(true);
  });

  it('generationPolicyPreview: returns user override when set', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { generationPolicyPreview(infoBitId: $id) { scope config sourcePolicyId } }`,
      { id: infoBitId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.generationPolicyPreview.scope).toBe('USER_DEFAULT');
    expect(r.data.generationPolicyPreview.sourcePolicyId).not.toBeNull();
    expect(r.data.generationPolicyPreview.config.targetCardCount).toBe(5);
  });

  it('upsertGenerationPolicy: category override beats user default', async () => {
    await gqlAuth(accessToken,
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId } }`,
      { input: { scope: 'CATEGORY', categoryId, config: { targetCardCount: 7, creativityLevel: 1, requiredCardStyles: ['direct_qa'] } } }
    );

    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { generationPolicyPreview(infoBitId: $id) { scope config } }`,
      { id: infoBitId }
    );
    expect(r.data.generationPolicyPreview.scope).toBe('CATEGORY');
    expect(r.data.generationPolicyPreview.config.targetCardCount).toBe(7);
  });

  it('generationPolicyByCategory: returns category policy', async () => {
    const r = await gqlAuth(accessToken,
      `query ($catId: ID!) { generationPolicyByCategory(categoryId: $catId) { policyId scope config } }`,
      { catId: categoryId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.generationPolicyByCategory).not.toBeNull();
    expect(r.data.generationPolicyByCategory.scope).toBe('CATEGORY');
  });

  it('generationPolicyByCategory: returns null when no policy exists', async () => {
    const other = await createTestUser({ email: 'gen-no-cat@test.com' });
    const r = await gqlAuth(other.accessToken,
      `query ($catId: ID!) { generationPolicyByCategory(categoryId: $catId) { policyId } }`,
      { catId: categoryId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.generationPolicyByCategory).toBeNull();
  });

  it('removeGenerationPolicy: deactivates policy', async () => {
    const create = await gqlAuth(accessToken,
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId } }`,
      { input: { scope: 'INFOBIT', infoBitId, config: { targetCardCount: 2, requiredCardStyles: ['direct_qa'] } } }
    );
    const policyId = create.data.upsertGenerationPolicy.policyId;

    const r = await gqlAuth(accessToken,
      `mutation ($id: ID!) { removeGenerationPolicy(policyId: $id) }`,
      { id: policyId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.removeGenerationPolicy).toBe(true);
  });

  it('upsertGenerationPolicy: validates config constraints', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId } }`,
      { input: { scope: 'USER_DEFAULT', config: { targetCardCount: 99 } } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/targetCardCount/);
  });

  it('upsertGenerationPolicy: validates card styles', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId } }`,
      { input: { scope: 'USER_DEFAULT', config: { requiredCardStyles: ['invalid_style'] } } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/Invalid card style/);
  });

  it('generationPolicyPreview: rejects without auth', async () => {
    const r = await gql(
      `query ($id: ID!) { generationPolicyPreview(infoBitId: $id) { scope } }`,
      { id: infoBitId }
    );
    expect(r.errors).toBeDefined();
  });

  it('upsertGenerationPolicy: rejects without auth', async () => {
    const r = await gql(
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId } }`,
      { input: { scope: 'USER_DEFAULT', config: { targetCardCount: 3 } } }
    );
    expect(r.errors).toBeDefined();
  });

  it('upsertGenerationPolicy: persists includeClozeCard and customInstructions', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId config } }`,
      { input: { scope: 'USER_DEFAULT', config: { targetCardCount: 3, includeClozeCard: true, customInstructions: 'Test instruction', requiredCardStyles: ['direct_qa'] } } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.upsertGenerationPolicy.config.includeClozeCard).toBe(true);
    expect(r.data.upsertGenerationPolicy.config.customInstructions).toBe('Test instruction');
  });

  it('upsertGenerationPolicy: accepts maxSocraticRounds up to 3', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId config } }`,
      { input: { scope: 'USER_DEFAULT', config: { maxSocraticRounds: 3, requiredCardStyles: ['direct_qa'] } } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.upsertGenerationPolicy.config.maxSocraticRounds).toBe(3);
  });

  it('upsertGenerationPolicy: rejects maxSocraticRounds=4', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId } }`,
      { input: { scope: 'USER_DEFAULT', config: { maxSocraticRounds: 4 } } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/maxSocraticRounds/);
  });

  it('upsertGenerationPolicy: validates socraticStages keys and values', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId } }`,
      { input: { scope: 'USER_DEFAULT', config: { socraticStages: { round1: 'invalid_stage' } } } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/socraticStages/);
  });

  it('upsertGenerationPolicy: rejects customInstructions over 4000 chars', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId } }`,
      { input: { scope: 'USER_DEFAULT', config: { customInstructions: 'x'.repeat(4001) } } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/customInstructions/);
  });

  it('generationPolicyPreview: new-word-plus gets category-specific system defaults', async () => {
    const newAuth = await createTestUser({ email: 'gen-nwp@test.com' });
    const cats = await gqlAuth(newAuth.accessToken, `query { categories { categoryId slug } }`);
    const nwpCat = cats.data.categories.find(c => c.slug === 'new-word-plus');
    expect(nwpCat).toBeDefined();

    const res = await gqlAuth(newAuth.accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'NWP Test', categoryId: nwpCat.categoryId, cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }] } }
    );
    const ibId = res.data.createInfoBit.infoBitId;

    const r = await gqlAuth(newAuth.accessToken,
      `query ($id: ID!) { generationPolicyPreview(infoBitId: $id) { scope config } }`,
      { id: ibId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.generationPolicyPreview.config.customInstructions).toMatch(/context/i);
    expect(r.data.generationPolicyPreview.config.targetCardCount).toBe(4);
    expect(r.data.generationPolicyPreview.config.includeClozeCard).toBe(true);
  });

  it('V1.1 backward compat: existing queries still work with old config shape', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpsertGenerationPolicyInput!) { upsertGenerationPolicy(input: $input) { policyId config } }`,
      { input: { scope: 'USER_DEFAULT', config: { targetCardCount: 2, requiredCardStyles: ['direct_qa'] } } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.upsertGenerationPolicy.config.targetCardCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// 20. Generation policy scale metadata
// ─────────────────────────────────────────────────────────────
describe('generation policy scale metadata', () => {
  it('generationPolicyScaleMetadata: returns creativity and strictness levels', async () => {
    const r = await gql(
      `query { generationPolicyScaleMetadata { creativity { level label blurb implication } strictness { level label blurb implication } } }`
    );
    expect(r.errors).toBeUndefined();
    const meta = r.data.generationPolicyScaleMetadata;
    expect(meta.creativity).toHaveLength(4);
    expect(meta.strictness).toHaveLength(4);
    expect(meta.creativity[0].level).toBe(1);
    expect(meta.creativity[3].level).toBe(4);
    expect(meta.strictness[0].label).toBe('Anchor-locked');
    meta.creativity.forEach(l => {
      expect(l.label).toBeTruthy();
      expect(l.blurb).toBeTruthy();
      expect(l.implication).toBeTruthy();
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 21. Learning preferences
// ─────────────────────────────────────────────────────────────
describe('learning preferences', () => {
  let accessToken, categoryId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'learn-pref@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;
  });

  it('myLearningPreferences: returns defaults when no row exists', async () => {
    const r = await gqlAuth(accessToken,
      `query { myLearningPreferences { newSessionDefaultCategoryId defaultSocraticEnabled defaultTags updatedAt } }`
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.myLearningPreferences.newSessionDefaultCategoryId).toBeNull();
    expect(r.data.myLearningPreferences.defaultSocraticEnabled).toBe(false);
    expect(r.data.myLearningPreferences.defaultTags).toEqual([]);
  });

  it('updateLearningPreferences: creates preferences on first call', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpdateLearningPreferencesInput!) { updateLearningPreferences(input: $input) { newSessionDefaultCategoryId defaultSocraticEnabled defaultTags updatedAt } }`,
      { input: { newSessionDefaultCategoryId: categoryId, defaultSocraticEnabled: true, defaultTags: ['vocab', 'daily'] } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.updateLearningPreferences.newSessionDefaultCategoryId).toBe(categoryId);
    expect(r.data.updateLearningPreferences.defaultSocraticEnabled).toBe(true);
    expect(r.data.updateLearningPreferences.defaultTags).toEqual(['vocab', 'daily']);
  });

  it('updateLearningPreferences: updates existing preferences', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpdateLearningPreferencesInput!) { updateLearningPreferences(input: $input) { defaultSocraticEnabled defaultTags } }`,
      { input: { defaultSocraticEnabled: false } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.updateLearningPreferences.defaultSocraticEnabled).toBe(false);
  });

  it('updateLearningPreferences: validates category access', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: UpdateLearningPreferencesInput!) { updateLearningPreferences(input: $input) { newSessionDefaultCategoryId } }`,
      { input: { newSessionDefaultCategoryId: '00000000-0000-0000-0000-000000000000' } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/not found|not accessible/i);
  });

  it('myLearningPreferences: rejects without auth', async () => {
    const r = await gql(`query { myLearningPreferences { defaultSocraticEnabled } }`);
    expect(r.errors).toBeDefined();
  });

  it('updateLearningPreferences: rejects without auth', async () => {
    const r = await gql(
      `mutation ($input: UpdateLearningPreferencesInput!) { updateLearningPreferences(input: $input) { defaultSocraticEnabled } }`,
      { input: { defaultSocraticEnabled: true } }
    );
    expect(r.errors).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 22. V2: Review Outcome Preview
// ─────────────────────────────────────────────────────────────
describe('reviewOutcomePreview', () => {
  let accessToken, categoryId, infoBitId, cardId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'v2-preview@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'V2 Preview', categoryId, cards: [
        { frontBlocks: [{ type: 'text', text: 'PQ' }], backBlocks: [{ type: 'text', text: 'PA' }] }
      ] } }
    );
    infoBitId = res.data.createInfoBit.infoBitId;
    cardId = res.data.createInfoBit.cards[0].cardId;
  });

  it('returns all 4 rating outcomes with displayText', async () => {
    const r = await gqlAuth(accessToken,
      `query ($input: ReviewOutcomePreviewInput!) {
        reviewOutcomePreview(input: $input) {
          infoBitId cardId asOf
          outcomes { rating nextDueAt scheduledSeconds stateAfter displayText isEstimate }
        }
      }`,
      { input: { infoBitId, cardId } }
    );
    expect(r.errors).toBeUndefined();
    const preview = r.data.reviewOutcomePreview;
    expect(preview.infoBitId).toBe(infoBitId);
    expect(preview.cardId).toBe(cardId);
    expect(preview.asOf).toBeTruthy();
    expect(preview.outcomes).toHaveLength(4);
    expect(preview.outcomes.map(o => o.rating)).toEqual(['AGAIN', 'HARD', 'GOOD', 'EASY']);
    preview.outcomes.forEach(o => {
      expect(o.nextDueAt).toBeTruthy();
      expect(typeof o.scheduledSeconds).toBe('number');
      expect(o.scheduledSeconds).toBeGreaterThanOrEqual(0);
      expect(o.stateAfter).toBeTruthy();
      expect(o.displayText).toMatch(/^Next review in /);
      expect(typeof o.isEstimate).toBe('boolean');
    });
  });

  it('accepts asOf parameter for time-pinned preview', async () => {
    const asOf = new Date().toISOString();
    const r = await gqlAuth(accessToken,
      `query ($input: ReviewOutcomePreviewInput!) {
        reviewOutcomePreview(input: $input) { asOf outcomes { rating scheduledSeconds } }
      }`,
      { input: { infoBitId, cardId, asOf } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.reviewOutcomePreview.asOf).toBeTruthy();
    expect(r.data.reviewOutcomePreview.outcomes).toHaveLength(4);
  });

  it('preview GOOD outcome matches submitReview GOOD result', async () => {
    const createRes = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'Match Test', categoryId, cards: [
        { frontBlocks: [{ type: 'text', text: 'MQ' }], backBlocks: [{ type: 'text', text: 'MA' }] }
      ] } }
    );
    const ibId = createRes.data.createInfoBit.infoBitId;
    const cId = createRes.data.createInfoBit.cards[0].cardId;

    const previewR = await gqlAuth(accessToken,
      `query ($input: ReviewOutcomePreviewInput!) {
        reviewOutcomePreview(input: $input) { outcomes { rating nextDueAt stateAfter } }
      }`,
      { input: { infoBitId: ibId, cardId: cId } }
    );
    const goodPreview = previewR.data.reviewOutcomePreview.outcomes.find(o => o.rating === 'GOOD');

    const submitR = await gqlAuth(accessToken,
      `mutation ($input: SubmitReviewInput!) { submitReview(input: $input) { nextDueAt stateAfter } }`,
      { input: { infoBitId: ibId, cardId: cId, rating: 'GOOD' } }
    );
    expect(submitR.errors).toBeUndefined();
    expect(goodPreview.stateAfter.stability).toBeCloseTo(submitR.data.submitReview.stateAfter.stability, 1);
    expect(goodPreview.stateAfter.difficulty).toBeCloseTo(submitR.data.submitReview.stateAfter.difficulty, 1);
  });

  it('rejects without auth', async () => {
    const r = await gql(
      `query ($input: ReviewOutcomePreviewInput!) { reviewOutcomePreview(input: $input) { infoBitId } }`,
      { input: { infoBitId, cardId } }
    );
    expect(r.errors).toBeDefined();
  });

  it('rejects unknown InfoBit', async () => {
    const r = await gqlAuth(accessToken,
      `query ($input: ReviewOutcomePreviewInput!) { reviewOutcomePreview(input: $input) { infoBitId } }`,
      { input: { infoBitId: '00000000-0000-0000-0000-000000000000', cardId } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/not found/i);
  });

  it('rejects unknown card', async () => {
    const r = await gqlAuth(accessToken,
      `query ($input: ReviewOutcomePreviewInput!) { reviewOutcomePreview(input: $input) { infoBitId } }`,
      { input: { infoBitId, cardId: '00000000-0000-0000-0000-000000000000' } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────
// 23. V2: Due Queue (Learn / Review / All)
// ─────────────────────────────────────────────────────────────
describe('dueQueue', () => {
  let accessToken, categoryId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'v2-queue@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;
  });

  it('ALL returns newly created InfoBits (state=New)', async () => {
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Queue All', categoryId, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    const id = res.data.createInfoBit.infoBitId;

    const r = await gqlAuth(accessToken,
      `query ($kind: DueQueueKind!) { dueQueue(kind: $kind) { infoBitId fsrsState reps lapses } }`,
      { kind: 'ALL' }
    );
    expect(r.errors).toBeUndefined();
    const item = r.data.dueQueue.find(i => i.infoBitId === id);
    expect(item).toBeDefined();
    expect(item.fsrsState).toBe(0);
    expect(item.reps).toBe(0);
  });

  it('LEARN returns new/learning items, excludes review-state items', async () => {
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'Queue Learn', categoryId, cards: [
        { frontBlocks: [{ type: 'text', text: 'LQ' }], backBlocks: [{ type: 'text', text: 'LA' }] }
      ] } }
    );
    const id = res.data.createInfoBit.infoBitId;

    const r = await gqlAuth(accessToken,
      `query ($kind: DueQueueKind!) { dueQueue(kind: $kind) { infoBitId fsrsState } }`,
      { kind: 'LEARN' }
    );
    expect(r.errors).toBeUndefined();
    const item = r.data.dueQueue.find(i => i.infoBitId === id);
    expect(item).toBeDefined();
    expect([0, 1, 3]).toContain(item.fsrsState);

    r.data.dueQueue.forEach(i => {
      expect([0, 1, 3]).toContain(i.fsrsState);
    });
  });

  it('REVIEW returns only review-state items', async () => {
    const r = await gqlAuth(accessToken,
      `query ($kind: DueQueueKind!) { dueQueue(kind: $kind) { infoBitId fsrsState } }`,
      { kind: 'REVIEW' }
    );
    expect(r.errors).toBeUndefined();
    r.data.dueQueue.forEach(i => {
      expect(i.fsrsState).toBe(2);
    });
  });

  it('respects limit parameter', async () => {
    const r = await gqlAuth(accessToken,
      `query ($kind: DueQueueKind!, $limit: Int) { dueQueue(kind: $kind, limit: $limit) { infoBitId } }`,
      { kind: 'ALL', limit: 1 }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.dueQueue.length).toBeLessThanOrEqual(1);
  });

  it('excludes archived InfoBits', async () => {
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Queue Archived', categoryId, cards: [
        { frontBlocks: [{ type: 'text', text: 'AQ' }], backBlocks: [{ type: 'text', text: 'AA' }] }
      ] } }
    );
    const archId = res.data.createInfoBit.infoBitId;
    await gqlAuth(accessToken, `mutation ($id: ID!) { archiveInfoBit(infoBitId: $id) { status } }`, { id: archId });

    const r = await gqlAuth(accessToken,
      `query ($kind: DueQueueKind!) { dueQueue(kind: $kind) { infoBitId } }`,
      { kind: 'ALL' }
    );
    expect(r.data.dueQueue.map(i => i.infoBitId)).not.toContain(archId);
  });

  it('rejects without auth', async () => {
    const r = await gql(`query { dueQueue(kind: ALL) { infoBitId } }`);
    expect(r.errors).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 24. V2: Daily Engagement Heatmap
// ─────────────────────────────────────────────────────────────
describe('dailyEngagement', () => {
  let accessToken, categoryId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'v2-engagement@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'Engagement Test', categoryId, cards: [
        { frontBlocks: [{ type: 'text', text: 'EQ' }], backBlocks: [{ type: 'text', text: 'EA' }] }
      ] } }
    );
    const ibId = res.data.createInfoBit.infoBitId;
    const cId = res.data.createInfoBit.cards[0].cardId;

    await gqlAuth(accessToken,
      `mutation ($input: SubmitReviewInput!) { submitReview(input: $input) { reviewEventId } }`,
      { input: { infoBitId: ibId, cardId: cId, rating: 'GOOD' } }
    );
  });

  it('returns daily points covering the window', async () => {
    const r = await gqlAuth(accessToken,
      `query ($days: Int) { dailyEngagement(windowDays: $days) { date addedCount learnedCount reviewedCount totalCount } }`,
      { days: 7 }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.dailyEngagement.length).toBe(7);
    r.data.dailyEngagement.forEach(p => {
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.addedCount).toBeGreaterThanOrEqual(0);
      expect(p.learnedCount).toBeGreaterThanOrEqual(0);
      expect(p.reviewedCount).toBeGreaterThanOrEqual(0);
      expect(p.totalCount).toBe(p.addedCount + p.learnedCount + p.reviewedCount);
    });
  });

  it('today has addedCount >= 1 (from beforeAll)', async () => {
    const r = await gqlAuth(accessToken,
      `query { dailyEngagement(windowDays: 1) { date addedCount learnedCount reviewedCount } }`
    );
    expect(r.errors).toBeUndefined();
    const today = r.data.dailyEngagement[0];
    expect(today.addedCount).toBeGreaterThanOrEqual(1);
  });

  it('today has learnedCount >= 1 (new card reviewed = learn)', async () => {
    const r = await gqlAuth(accessToken,
      `query { dailyEngagement(windowDays: 1) { date learnedCount } }`
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.dailyEngagement[0].learnedCount).toBeGreaterThanOrEqual(1);
  });

  it('defaults to 365 days when windowDays omitted', async () => {
    const r = await gqlAuth(accessToken,
      `query { dailyEngagement { date } }`
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.dailyEngagement.length).toBe(365);
  });

  it('clamps windowDays to max 365', async () => {
    const r = await gqlAuth(accessToken,
      `query ($days: Int) { dailyEngagement(windowDays: $days) { date } }`,
      { days: 999 }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.dailyEngagement.length).toBe(365);
  });

  it('rejects without auth', async () => {
    const r = await gql(`query { dailyEngagement { date } }`);
    expect(r.errors).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 25. V2: Backward Compatibility
// ─────────────────────────────────────────────────────────────
describe('V2 backward compatibility', () => {
  let accessToken, categoryId, infoBitId, cardId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'v2-backcompat@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId cards { cardId } } }`,
      { input: { title: 'Backcompat', categoryId, cards: [
        { frontBlocks: [{ type: 'text', text: 'BQ' }], backBlocks: [{ type: 'text', text: 'BA' }] }
      ] } }
    );
    infoBitId = res.data.createInfoBit.infoBitId;
    cardId = res.data.createInfoBit.cards[0].cardId;
  });

  it('dueInfoBits still works unchanged', async () => {
    const r = await gqlAuth(accessToken, `query { dueInfoBits { infoBitId title dueAt } }`);
    expect(r.errors).toBeUndefined();
    expect(r.data.dueInfoBits.find(d => d.infoBitId === infoBitId)).toBeDefined();
  });

  it('nextReviewCard still works with ratingPreviews', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { nextReviewCard(infoBitId: $id) { infoBitId card { cardId } dueAt allowedRatings ratingPreviews { rating nextDueAt } } }`,
      { id: infoBitId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.nextReviewCard.ratingPreviews).toHaveLength(4);
  });

  it('submitReview still works unchanged', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: SubmitReviewInput!) { submitReview(input: $input) { reviewEventId nextDueAt stateAfter } }`,
      { input: { infoBitId, cardId, rating: 'GOOD' } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.submitReview.reviewEventId).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────
// 26. V2: NoteSpec Persistence
// ─────────────────────────────────────────────────────────────
describe('NoteSpec persistence', () => {
  let accessToken, categoryId;

  const VALID_NOTE_SPEC = {
    coreAnswer: 'Mitochondria is the powerhouse of the cell',
    coreExplanation: 'Converts nutrients into ATP via cellular respiration',
    exactnessMode: 'TERM_EXACT',
    selectedDeepAttributes: ['CONTEXT', 'SIGNIFICANCE'],
    deepAttributes: {
      CONTEXT: 'Biology, cell biology',
      SIGNIFICANCE: 'Fundamental concept in understanding cell energy production'
    },
    frontReminderText: 'Think about cell energy...',
    maxIndependentFactsPerNote: 1,
    memoryArchetype: 'technical-definition'
  };

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'notespec@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;
  });

  it('createInfoBit succeeds without noteSpec (legacy path)', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId noteSpec } }`,
      { input: { title: 'No NoteSpec', categoryId, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.createInfoBit.noteSpec).toBeNull();
  });

  it('createInfoBit persists valid noteSpec', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId noteSpec } }`,
      { input: { title: 'With NoteSpec', categoryId, noteSpec: VALID_NOTE_SPEC, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.createInfoBit.noteSpec).toBeTruthy();
    expect(r.data.createInfoBit.noteSpec.coreAnswer).toBe(VALID_NOTE_SPEC.coreAnswer);
    expect(r.data.createInfoBit.noteSpec.exactnessMode).toBe('TERM_EXACT');
    expect(r.data.createInfoBit.noteSpec.selectedDeepAttributes).toEqual(['CONTEXT', 'SIGNIFICANCE']);
  });

  it('infoBit query returns persisted noteSpec', async () => {
    const create = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'ReadBack NoteSpec', categoryId, noteSpec: VALID_NOTE_SPEC, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    const ibId = create.data.createInfoBit.infoBitId;

    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { infoBit(infoBitId: $id) { noteSpec } }`,
      { id: ibId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.infoBit.noteSpec.coreAnswer).toBe(VALID_NOTE_SPEC.coreAnswer);
    expect(r.data.infoBit.noteSpec.memoryArchetype).toBe('technical-definition');
  });

  it('infoBits list returns noteSpec', async () => {
    const r = await gqlAuth(accessToken,
      `query { infoBits { edges { infoBitId noteSpec } } }`
    );
    expect(r.errors).toBeUndefined();
    const withSpec = r.data.infoBits.edges.filter(e => e.noteSpec !== null);
    expect(withSpec.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects empty coreAnswer', async () => {
    const badSpec = { ...VALID_NOTE_SPEC, coreAnswer: '' };
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Bad Core', categoryId, noteSpec: badSpec, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/coreAnswer/i);
  });

  it('rejects invalid exactnessMode', async () => {
    const badSpec = { ...VALID_NOTE_SPEC, exactnessMode: 'INVALID' };
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Bad Mode', categoryId, noteSpec: badSpec, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/exactnessMode/i);
  });

  it('rejects invalid deep attribute name', async () => {
    const badSpec = { ...VALID_NOTE_SPEC, selectedDeepAttributes: ['INVALID_ATTR'] };
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Bad Attr', categoryId, noteSpec: badSpec, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/deep attribute/i);
  });

  it('rejects when selected deep attribute value is missing', async () => {
    const badSpec = {
      ...VALID_NOTE_SPEC,
      selectedDeepAttributes: ['CONTEXT', 'DOMAIN'],
      deepAttributes: { CONTEXT: 'Biology' }
    };
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Missing Attr Val', categoryId, noteSpec: badSpec, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/DOMAIN/);
  });

  it('rejects when frontReminderText missing with deep attributes', async () => {
    const badSpec = { ...VALID_NOTE_SPEC, frontReminderText: '' };
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'No Reminder', categoryId, noteSpec: badSpec, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/frontReminderText/i);
  });

  it('rejects maxIndependentFactsPerNote < 1', async () => {
    const badSpec = { ...VALID_NOTE_SPEC, maxIndependentFactsPerNote: 0 };
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Bad Facts', categoryId, noteSpec: badSpec, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/maxIndependentFactsPerNote/i);
  });

  it('accepts noteSpec with empty selectedDeepAttributes (no frontReminderText needed)', async () => {
    const minSpec = {
      coreAnswer: 'Simple fact',
      exactnessMode: 'GIST',
      selectedDeepAttributes: [],
      deepAttributes: {},
      maxIndependentFactsPerNote: 1
    };
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId noteSpec } }`,
      { input: { title: 'Min NoteSpec', categoryId, noteSpec: minSpec, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.createInfoBit.noteSpec.exactnessMode).toBe('GIST');
  });
});

// ─────────────────────────────────────────────────────────────
// 27. V2: Category Migration
// ─────────────────────────────────────────────────────────────
describe('category migration', () => {
  let accessToken, factCategoryId, virtueCategoryId;

  beforeAll(async () => {
    const auth = await createTestUser({ email: 'migration@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId slug } }`);
    factCategoryId = cats.data.categories.find(c => c.slug === 'fact').categoryId;
    virtueCategoryId = cats.data.categories.find(c => c.slug === 'virtue-life-lesson').categoryId;
  });

  it('dry-run returns correct counts without modifying data', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Migration Dry', categoryId: factCategoryId,
        noteSpec: { coreAnswer: 'test', exactnessMode: 'GIST', selectedDeepAttributes: [], deepAttributes: {}, maxIndependentFactsPerNote: 1, memoryArchetype: 'virtue-life-lesson' },
        cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }]
      } }
    );
    const ibId = r.data.createInfoBit.infoBitId;

    const { runCategoryMigration } = require('../src/infrastructure/postgres/sequelize');
    const report = await runCategoryMigration({ dryRun: true });
    expect(report.wouldMigrate).toBeGreaterThanOrEqual(1);
    expect(report.breakdown['virtue-life-lesson']).toBeGreaterThanOrEqual(1);

    const { models } = getModels();
    const ib = await models.InfoBit.findByPk(ibId);
    expect(ib.category_id).toBe(factCategoryId);
  });

  it('run reassigns category and creates activity event', async () => {
    const { runCategoryMigration } = require('../src/infrastructure/postgres/sequelize');
    const report = await runCategoryMigration({ dryRun: false });
    expect(report.wouldMigrate).toBeGreaterThanOrEqual(1);

    const { models } = getModels();
    const meResult = await gqlAuth(accessToken, `query { me { userId } }`);
    const userId = meResult.data.me.userId;
    const events = await models.ActivityEvent.findAll({
      where: { event_type: 'infobit.category_migrated', user_id: userId }
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const virtueEvent = events.find(e => e.payload.to_category_id === virtueCategoryId);
    expect(virtueEvent).toBeDefined();
    expect(virtueEvent.payload.from_category_id).toBe(factCategoryId);
  });

  it('second run is idempotent (0 changes)', async () => {
    const { runCategoryMigration } = require('../src/infrastructure/postgres/sequelize');
    const report = await runCategoryMigration({ dryRun: false });
    expect(report.wouldMigrate).toBe(0);
    expect(report.noActionNeeded).toBeGreaterThanOrEqual(1);
  });

  it('InfoBits without noteSpec are untouched', async () => {
    const r = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'No Spec', categoryId: factCategoryId,
        cards: [{ frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }]
      } }
    );
    const ibId = r.data.createInfoBit.infoBitId;

    const { runCategoryMigration } = require('../src/infrastructure/postgres/sequelize');
    await runCategoryMigration({ dryRun: false });

    const { models } = getModels();
    const ib = await models.InfoBit.findByPk(ibId);
    expect(ib.category_id).toBe(factCategoryId);
  });
});

// ─────────────────────────────────────────────────────────────
// 28. V2: Feature Flags
// ─────────────────────────────────────────────────────────────
describe('feature flags', () => {
  it('health query returns featureFlags in non-production', async () => {
    const r = await gql(`query { health { ok service featureFlags } }`);
    expect(r.errors).toBeUndefined();
    expect(r.data.health.featureFlags).toBeTruthy();
    expect(typeof r.data.health.featureFlags).toBe('object');
    expect(r.data.health.featureFlags).toHaveProperty('noteSpecValidator');
  });

  it('featureFlags includes noteSpecValidator boolean', async () => {
    const r = await gql(`query { health { featureFlags } }`);
    expect(typeof r.data.health.featureFlags.noteSpecValidator).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────
// 29. V2: NoteSpec Validator
// ─────────────────────────────────────────────────────────────
describe('validateNoteSpec', () => {
  let accessToken, categoryId, goodInfoBitId, noSpecInfoBitId;
  const config = require('../src/app/config');

  beforeAll(async () => {
    config.featureFlags.noteSpecValidator = true;

    const auth = await createTestUser({ email: 'validator@test.com' });
    accessToken = auth.accessToken;
    const cats = await gqlAuth(accessToken, `query { categories { categoryId } }`);
    categoryId = cats.data.categories[0].categoryId;

    const goodSpec = {
      coreAnswer: 'Mitochondria',
      exactnessMode: 'TERM_EXACT',
      selectedDeepAttributes: ['CONTEXT'],
      deepAttributes: { CONTEXT: 'cell biology' },
      frontReminderText: 'powerhouse',
      maxIndependentFactsPerNote: 2
    };
    const goodRes = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Good Validator', categoryId, noteSpec: goodSpec, cards: [
        { frontBlocks: [{ type: 'text', text: 'What is the powerhouse of the cell?' }],
          backBlocks: [{ type: 'text', text: 'Mitochondria — essential for cell biology' }] }
      ] } }
    );
    goodInfoBitId = goodRes.data.createInfoBit.infoBitId;

    const noSpecRes = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'No Spec Validator', categoryId, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'A' }] }
      ] } }
    );
    noSpecInfoBitId = noSpecRes.data.createInfoBit.infoBitId;
  });

  afterAll(() => {
    config.featureFlags.noteSpecValidator = false;
  });

  it('returns all 6 checks for valid InfoBit', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { validateNoteSpec(infoBitId: $id) { isValid checks { name passed message } } }`,
      { id: goodInfoBitId }
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.validateNoteSpec.checks).toHaveLength(6);
    const names = r.data.validateNoteSpec.checks.map(c => c.name);
    expect(names).toContain('CORE_ANSWER_CONSISTENT');
    expect(names).toContain('DEEP_ATTRIBUTES_PRESENT');
    expect(names).toContain('BACK_STARTS_WITH_CORE');
    expect(names).toContain('NO_TRUE_FALSE_STYLE');
    expect(names).toContain('FRONT_HAS_REMINDER');
    expect(names).toContain('MAX_FACTS_RESPECTED');
  });

  it('well-formed InfoBit passes all checks', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { validateNoteSpec(infoBitId: $id) { isValid checks { name passed } } }`,
      { id: goodInfoBitId }
    );
    expect(r.data.validateNoteSpec.isValid).toBe(true);
    r.data.validateNoteSpec.checks.forEach(c => {
      expect(c.passed).toBe(true);
    });
  });

  it('CORE_ANSWER_CONSISTENT fails when back does not contain core answer', async () => {
    const spec = {
      coreAnswer: 'Photosynthesis',
      exactnessMode: 'GIST',
      selectedDeepAttributes: [],
      deepAttributes: {},
      maxIndependentFactsPerNote: 1
    };
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Bad Core', categoryId, noteSpec: spec, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q' }], backBlocks: [{ type: 'text', text: 'Something unrelated' }] }
      ] } }
    );
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { validateNoteSpec(infoBitId: $id) { isValid checks { name passed message } } }`,
      { id: res.data.createInfoBit.infoBitId }
    );
    expect(r.data.validateNoteSpec.isValid).toBe(false);
    const check = r.data.validateNoteSpec.checks.find(c => c.name === 'CORE_ANSWER_CONSISTENT');
    expect(check.passed).toBe(false);
    expect(check.message).toBeTruthy();
  });

  it('NO_TRUE_FALSE_STYLE fails when front is "True"', async () => {
    const spec = {
      coreAnswer: 'True',
      exactnessMode: 'GIST',
      selectedDeepAttributes: [],
      deepAttributes: {},
      maxIndependentFactsPerNote: 1
    };
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'TF Style', categoryId, noteSpec: spec, cards: [
        { frontBlocks: [{ type: 'text', text: 'True' }], backBlocks: [{ type: 'text', text: 'True — this is correct' }] }
      ] } }
    );
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { validateNoteSpec(infoBitId: $id) { checks { name passed } } }`,
      { id: res.data.createInfoBit.infoBitId }
    );
    const check = r.data.validateNoteSpec.checks.find(c => c.name === 'NO_TRUE_FALSE_STYLE');
    expect(check.passed).toBe(false);
  });

  it('DEEP_ATTRIBUTES_PRESENT fails when attribute value missing from cards', async () => {
    const spec = {
      coreAnswer: 'Answer',
      exactnessMode: 'GIST',
      selectedDeepAttributes: ['DOMAIN'],
      deepAttributes: { DOMAIN: 'quantum physics' },
      frontReminderText: 'hint',
      maxIndependentFactsPerNote: 1
    };
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Missing Attr', categoryId, noteSpec: spec, cards: [
        { frontBlocks: [{ type: 'text', text: 'hint question' }], backBlocks: [{ type: 'text', text: 'Answer without the domain' }] }
      ] } }
    );
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { validateNoteSpec(infoBitId: $id) { checks { name passed message } } }`,
      { id: res.data.createInfoBit.infoBitId }
    );
    const check = r.data.validateNoteSpec.checks.find(c => c.name === 'DEEP_ATTRIBUTES_PRESENT');
    expect(check.passed).toBe(false);
    expect(check.message).toMatch(/DOMAIN/);
  });

  it('MAX_FACTS_RESPECTED fails when card count exceeds limit', async () => {
    const spec = {
      coreAnswer: 'Answer',
      exactnessMode: 'GIST',
      selectedDeepAttributes: [],
      deepAttributes: {},
      maxIndependentFactsPerNote: 1
    };
    const res = await gqlAuth(accessToken,
      `mutation ($input: CreateInfoBitInput!) { createInfoBit(input: $input) { infoBitId } }`,
      { input: { title: 'Too Many Cards', categoryId, noteSpec: spec, cards: [
        { frontBlocks: [{ type: 'text', text: 'Q1' }], backBlocks: [{ type: 'text', text: 'Answer one' }] },
        { frontBlocks: [{ type: 'text', text: 'Q2' }], backBlocks: [{ type: 'text', text: 'Answer two' }] }
      ] } }
    );
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { validateNoteSpec(infoBitId: $id) { checks { name passed } } }`,
      { id: res.data.createInfoBit.infoBitId }
    );
    const check = r.data.validateNoteSpec.checks.find(c => c.name === 'MAX_FACTS_RESPECTED');
    expect(check.passed).toBe(false);
  });

  it('rejects InfoBit with no noteSpec', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { validateNoteSpec(infoBitId: $id) { isValid } }`,
      { id: noSpecInfoBitId }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/no noteSpec/i);
  });

  it('rejects when feature flag is disabled', async () => {
    config.featureFlags.noteSpecValidator = false;
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { validateNoteSpec(infoBitId: $id) { isValid } }`,
      { id: goodInfoBitId }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/not enabled/i);
    config.featureFlags.noteSpecValidator = true;
  });

  it('rejects without auth', async () => {
    const r = await gql(
      `query ($id: ID!) { validateNoteSpec(infoBitId: $id) { isValid } }`,
      { id: goodInfoBitId }
    );
    expect(r.errors).toBeDefined();
  });

  it('rejects unknown InfoBit', async () => {
    const r = await gqlAuth(accessToken,
      `query ($id: ID!) { validateNoteSpec(infoBitId: $id) { isValid } }`,
      { id: '00000000-0000-0000-0000-000000000000' }
    );
    expect(r.errors).toBeDefined();
    expect(r.errors[0].message).toMatch(/not found/i);
  });
});
