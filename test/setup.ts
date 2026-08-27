// Vitest global setup.
//
// Some server modules (e.g. lib/db/client.ts) construct a Neon client at import
// time and throw if DATABASE_URL is unset. The Neon HTTP driver is lazy (no
// connection until a query runs), and tests that touch the DB mock the client,
// so a dummy URL here just lets those modules import without a real database.
process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";
