# spaced-rep-api

Backend API scaffold for the spaced repetition app.

## Stack
- Node.js
- Apollo GraphQL (`@apollo/server`)
- PostgreSQL (`sequelize`)
- MongoDB (`mongoose`)

## Quick start
1. Copy `.env.example` to `.env` and set real secrets/connection URLs.
2. Install dependencies:
   - `npm install`
3. Run:
   - `npm run dev`
4. Open GraphQL endpoint:
   - `http://localhost:4000/`

## Current state
- Bootstrapped server with first working API slice:
  - `signUp`, `signIn`, `me`, `categories`, `createInfoBit`, `infoBits`, `health`
- DB connection bootstrap for PostgreSQL + MongoDB.
- Sequelize model materialization support via `DB_SYNC=true`.
- Architecture spec: `../docs/V1_BACKEND_SPEC.md`.
- JS model artifacts (canonical): `../docs/MODEL_ARTIFACTS_JS.md`.
- GraphQL contract draft: `../docs/graphql/v1.graphql`.
- User action/API matrix: `../docs/API_ACTION_CATALOG.md`.
- Action readiness audit: `../docs/API_ACTION_READINESS_AUDIT.md`.
- Local setup + first test guide: `../docs/LOCAL_SETUP_AND_FIRST_TEST.md`.

## Next implementation order
1. Auth + sessions module.
2. Categories/tags module.
3. InfoBit + card CRUD with dual-write.
4. FSRS scheduling + review pipeline.
5. Flags + activity events.
