// Route constants (docs/CONTRACTS.md §4).
// TODO(WS3): AGENT_ROUTES and PARTY_ROUTES + their request/response schemas.

export const AI_ROUTES = {
  health: '/health',
  parse: '/parse',
  explain: '/explain',
  explainSync: '/explain/sync',
} as const;
