// Empty stub aliased in place of the `server-only` / `client-only` marker
// packages when running under vitest. Those packages throw if imported outside
// the Next.js server/client build; in unit tests we only exercise the pure
// functions in server modules, so mapping them to this no-op lets those modules
// import cleanly.
export {};
