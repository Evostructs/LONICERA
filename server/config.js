const path = require('path');

function intFromEnv(name, fallback, min, max) {
  const value = parseInt(process.env[name], 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function boolFromEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function stringFromEnv(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  return trimmed || fallback;
}

function loadConfig() {
  const rawCorsOrigin = process.env.CORS_ORIGIN && process.env.CORS_ORIGIN.trim();
  const corsOrigin = rawCorsOrigin || '*';
  const solverSpotRuntime = stringFromEnv('SOLVER_BTN_BB_SRP_50BB_RUNTIME', '');
  const derivedSolverDataDir = solverSpotRuntime
    ? path.dirname(path.dirname(solverSpotRuntime))
    : '';
  const socketCorsOrigin =
    corsOrigin === '*'
      ? '*'
      : corsOrigin
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean);

  return {
    port: process.env.PORT || 2026,
    host: process.env.HOST || '0.0.0.0',
    logLevel: process.env.LOG_LEVEL || 'info',
    corsOrigin,
    socketCorsOrigin,
    trustProxy: boolFromEnv('TRUST_PROXY', false),
    maxWsConnections: intFromEnv('MAX_WS_CONNECTIONS', 200, 1, 5000),
    httpRateLimit: intFromEnv('HTTP_RATE_LIMIT', 240, 1, 10000),
    httpRateWindow: intFromEnv('HTTP_RATE_WINDOW_MS', 60000, 1000, 3600000),
    maxRooms: intFromEnv('MAX_ROOMS', 50, 1, 1000),
    hostTransferGraceMs: intFromEnv('HOST_TRANSFER_GRACE_MS', 120000, 100, 600000),
    preflopSims: intFromEnv('PREFLOP_SIMS', 10000, 0, 100000),
    preflopTableEnabled: !['0', 'false', 'off', 'no'].includes(
      String(process.env.PREFLOP_TABLE || 'on').toLowerCase()
    ),
    solverDataDir: stringFromEnv('SOLVER_DATA_DIR', derivedSolverDataDir),
    solverRootCacheDir: stringFromEnv(
      'SOLVER_ROOT_CACHE_DIR',
      path.join(__dirname, '..', '.cache', 'solver-root-runtime')
    ),
    npcModel: {
      enabled: !['0', 'false', 'off', 'no'].includes(
        String(process.env.NPC_MODEL_ENABLED || 'off').toLowerCase()
      ),
      url: stringFromEnv('NPC_MODEL_URL', stringFromEnv('AI_SERVER_URL', 'http://127.0.0.1:8900')),
      timeoutMs: intFromEnv('NPC_MODEL_TIMEOUT_MS', 800, 50, 10000),
      minConfidence: Math.max(
        0,
        Math.min(1, Number.parseFloat(process.env.NPC_MODEL_MIN_CONFIDENCE || '0.18') || 0.18)
      ),
    },
    pokerSkill: {
      enabled: boolFromEnv('POKERSKILL_ENABLED', false),
      url: stringFromEnv('POKERSKILL_URL', 'http://127.0.0.1:8910'),
      timeoutMs: intFromEnv('POKERSKILL_TIMEOUT_MS', 12000, 100, 60000),
    },
  };
}

module.exports = { boolFromEnv, intFromEnv, loadConfig, stringFromEnv };
