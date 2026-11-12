const { buildSessionProfile, localFallbackDecision, trySolverDecision } = require('./npc');
const { applyPersonaDeviation, isSolverEligibleProfile } = require('./solver-persona');
const { buildModelRequest } = require('./npc-model-features');
const { requestModelDecision, validateModelResponse, DEFAULT_TIMEOUT_MS } = require('./npc-remote-client');
const {
  buildPokerSkillRequest,
  defaultPokerSkillConfig,
  requestPokerSkillDecision,
  validatePokerSkillResponse,
} = require('./pokerskill-client');
const { translatePolicyDecision } = require('./solver-translate');

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function defaultModelConfig() {
  return {
    enabled: !['0', 'false', 'off', 'no'].includes(String(process.env.NPC_MODEL_ENABLED || 'off').toLowerCase()),
    url: process.env.AI_SERVER_URL || process.env.NPC_MODEL_URL || 'http://127.0.0.1:8900',
    timeoutMs: Number(process.env.NPC_MODEL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    minConfidence: Number(process.env.NPC_MODEL_MIN_CONFIDENCE || 0.18),
  };
}

function setDecisionTrace(gameState, trace) {
  gameState._decisionTrace = trace;
  return trace;
}

function annotateDecision(decision, trace) {
  return {
    ...decision,
    _decisionSource: trace.status,
    _decisionTrace: trace,
  };
}

function fallbackDecision(profile, holeCards, communityCards, gameState, reason, extra = {}) {
  const decision = localFallbackDecision(profile, holeCards, communityCards, gameState);
  const trace = setDecisionTrace(gameState, {
    status: 'fallback',
    reason,
    fallbackReason: reason,
    ...extra,
  });
  return annotateDecision(decision, trace);
}

async function decideNpcAction({
  profile,
  holeCards,
  communityCards,
  gameState,
  players = [],
  pokerSkillConfig = defaultPokerSkillConfig(),
  pokerSkillClient = requestPokerSkillDecision,
  remoteConfig = defaultModelConfig(),
  remoteClient = requestModelDecision,
}) {
  const sessionProfile = buildSessionProfile(profile);
  const solverDecision = trySolverDecision(
    profile,
    sessionProfile,
    holeCards,
    communityCards,
    gameState
  );
  if (solverDecision) {
    const trace = setDecisionTrace(gameState, {
      ...gameState._solverTrace,
      status: 'solver_hit',
      reason: 'solver_strategy_applied',
      latencyMs: gameState?._solverTrace?.lookupMs || 0,
      selectedAction: solverDecision.action,
      confidence: 1,
      modelVersion: null,
      coverageStatus: 'solver_exact',
    });
    return annotateDecision(solverDecision, trace);
  }

  const pokerSkillPayload = buildPokerSkillRequest({
    profile,
    holeCards,
    communityCards,
    gameState: {
      ...gameState,
      communityCards,
    },
    players,
  });

  if (pokerSkillConfig?.enabled) {
    if (pokerSkillPayload.coverage?.supported) {
      const pokerSkillStartedAt = nowMs();
      try {
        const response = await pokerSkillClient({
          url: pokerSkillConfig.url,
          payload: pokerSkillPayload,
          timeoutMs: pokerSkillConfig.timeoutMs,
        });
        const validated = validatePokerSkillResponse(response, pokerSkillPayload);
        if (validated.ok) {
          const latencyMs =
            Number.isFinite(response.latencyMs)
              ? response.latencyMs
              : Math.round((nowMs() - pokerSkillStartedAt) * 100) / 100;
          const trace = setDecisionTrace(gameState, {
            status: 'pokerskill_hit',
            reason: 'pokerskill_harness_applied',
            selectedAction: response.action || response.selectedAction || validated.decision.action,
            latencyMs,
            modelVersion: response.modelVersion || null,
            coverageStatus: pokerSkillPayload.coverage.reason,
          });
          gameState._pokerSkillTrace = trace;
          return annotateDecision(validated.decision, trace);
        }
        gameState._pokerSkillTrace = {
          status: 'pokerskill_miss',
          reason: validated.reason,
          latencyMs: Math.round((nowMs() - pokerSkillStartedAt) * 100) / 100,
          coverageStatus: pokerSkillPayload.coverage.reason,
        };
      } catch (error) {
        gameState._pokerSkillTrace = {
          status: 'pokerskill_miss',
          reason:
            error?.code === 'ETIMEDOUT' || error?.message === 'ETIMEDOUT'
              ? 'pokerskill_timeout'
              : 'pokerskill_request_failed',
          latencyMs: Math.round((nowMs() - pokerSkillStartedAt) * 100) / 100,
          coverageStatus: pokerSkillPayload.coverage.reason,
          error: error?.message || String(error),
        };
      }
    } else {
      gameState._pokerSkillTrace = {
        status: 'pokerskill_skipped',
        reason: pokerSkillPayload.coverage?.reason || 'unsupported_context',
      };
    }
  }

  const requestPayload = buildModelRequest({
    profile,
    holeCards,
    communityCards,
    gameState: {
      ...gameState,
      communityCards,
      players,
    },
    solverAvailable:
      !!gameState?.solverContext?.supported &&
      isSolverEligibleProfile(profile),
  });

  if (!remoteConfig.enabled) {
    return fallbackDecision(profile, holeCards, communityCards, gameState, 'model_disabled', {
      coverageStatus: requestPayload.coverage.reason,
      pokerSkillReason: gameState._pokerSkillTrace?.reason || null,
    });
  }

  if (!requestPayload.coverage.supported) {
    return fallbackDecision(profile, holeCards, communityCards, gameState, 'model_spot_not_covered', {
      coverageStatus: requestPayload.coverage.reason,
      pokerSkillReason: gameState._pokerSkillTrace?.reason || null,
    });
  }

  const modelStartedAt = nowMs();
  try {
    const response = await remoteClient({
      url: remoteConfig.url,
      payload: requestPayload,
      timeoutMs: remoteConfig.timeoutMs,
    });
    const validated = validateModelResponse(response, requestPayload.legalActions);
    if (!validated.ok) {
      return fallbackDecision(profile, holeCards, communityCards, gameState, validated.reason, {
        latencyMs: Math.round((nowMs() - modelStartedAt) * 100) / 100,
        coverageStatus: requestPayload.coverage.reason,
        pokerSkillReason: gameState._pokerSkillTrace?.reason || null,
      });
    }
    if (validated.confidence < remoteConfig.minConfidence) {
      return fallbackDecision(profile, holeCards, communityCards, gameState, 'model_low_confidence', {
        latencyMs: validated.latencyMs,
        confidence: validated.confidence,
        modelVersion: validated.modelVersion,
        coverageStatus: validated.coverageStatus || requestPayload.coverage.reason,
        pokerSkillReason: gameState._pokerSkillTrace?.reason || null,
      });
    }

    const deviatedPolicy = applyPersonaDeviation(
      validated.normalizedPolicy,
      profile,
      gameState.psychMods || {},
      {
        allowedActions: requestPayload.legalActions,
        confidence: validated.confidence,
        maxTotalShift: 0.12,
      }
    );
    if (!deviatedPolicy) {
      return fallbackDecision(profile, holeCards, communityCards, gameState, 'model_persona_empty', {
        latencyMs: validated.latencyMs,
        modelVersion: validated.modelVersion,
        coverageStatus: validated.coverageStatus || requestPayload.coverage.reason,
        pokerSkillReason: gameState._pokerSkillTrace?.reason || null,
      });
    }

    const translated = translatePolicyDecision(
      {
        policy: deviatedPolicy,
        selectedAction: validated.selectedAction,
      },
      gameState,
      () => Math.random()
    );
    if (!translated) {
      return fallbackDecision(profile, holeCards, communityCards, gameState, 'model_translation_failed', {
        latencyMs: validated.latencyMs,
        modelVersion: validated.modelVersion,
        confidence: validated.confidence,
        coverageStatus: validated.coverageStatus || requestPayload.coverage.reason,
        pokerSkillReason: gameState._pokerSkillTrace?.reason || null,
      });
    }

    const decision = translated.action === 'raise'
      ? { action: translated.action, amount: translated.amount, _model: true }
      : { action: translated.action, _model: true };
    const trace = setDecisionTrace(gameState, {
      status: 'model_hit',
      reason: 'remote_model_policy_applied',
      selectedAction: translated.selectedAction,
      confidence: validated.confidence,
      latencyMs: validated.latencyMs,
      modelVersion: validated.modelVersion,
      coverageStatus: validated.coverageStatus || requestPayload.coverage.reason,
      policy: translated.normalizedPolicy,
    });
    return annotateDecision(decision, trace);
  } catch (error) {
    const reason = error?.code === 'ETIMEDOUT' || error?.message === 'ETIMEDOUT'
      ? 'model_timeout'
      : 'model_request_failed';
    return fallbackDecision(profile, holeCards, communityCards, gameState, reason, {
      latencyMs: Math.round((nowMs() - modelStartedAt) * 100) / 100,
      modelVersion: null,
      coverageStatus: requestPayload.coverage.reason,
      error: error?.message || String(error),
      pokerSkillReason: gameState._pokerSkillTrace?.reason || null,
    });
  }
}

module.exports = {
  decideNpcAction,
  defaultModelConfig,
};
