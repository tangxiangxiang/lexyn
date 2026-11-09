export type HealthResponse =
  | { status: 'ok'; database: 'ok' }
  | { status: 'unavailable'; database: 'unavailable' }
