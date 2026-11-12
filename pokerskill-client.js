const { cardCode } = require('./solver-board');

const DEFAULT_TIMEOUT_MS = 12000;
const VALID_STREETS = new Set(['preflop', 'flop', 'turn', 'river']);

function isOff(value) {
  return ['0', 'false', 'off', 'no', ''].includes(String(value || '').trim().toLowerCase());
}

function defaultPokerSkillConfig() {
  return {
    enabled: !isOff(process.env.POKERSKILL_ENABLED || 'off'),
    url: process.env.POKERSKILL_URL || 'http://127.0.0.1:8910',
    timeoutMs: Number(process.env.POKERSKILL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(new Error('ETIMEDOUT')), timeoutMs);
  if (handle.unref) handle.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(handle);
    },
  };
}

async function postJson({ url, path, body, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = global.fetch }) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable');
  }
  const { signal, dispose } = createTimeoutSignal(timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(new URL(path, url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal,
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json?.error || `HTTP_${response.status}`);
    }
    return {
      ...json,
      latencyMs: Number.isFinite(json?.latencyMs) ? json.latencyMs : Date.now() - startedAt,
    };
  } catch (error) {
    if (signal.aborted) {
      const timeoutError = new Error('ETIMEDOUT');
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    dispose();
  }
}

function requestPokerSkillDecision({
  url,
  payload,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = global.fetch,
}) {
  return postJson({
    url,
    path: '/decide',
    body: payload,
    timeoutMs,
    fetchImpl,
  });
}

function roundBb(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function chipsToBb(value, bigBlind) {
  return roundBb(Number(value || 0) / Math.max(1, Number(bigBlind || 0)));
}

function amountToken(amount, bigBlind) {
  const bb = chipsToBb(amount, bigBlind);
  return Number.isInteger(bb) ? String(bb) : String(bb).replace(/0+$/, '').replace(/\.$/, '');
}

function livePlayers(players = []) {
  return players.filter((player) => !player.folded && (player.chips > 0 || player.allIn));
}

function findHeroAndVillain(players = [], gameState = {}) {
  const hero = players.find((player) => player.id === gameState.currentPlayerId);
  const live = livePlayers(players);
  const villain = live.find((player) => player.id !== gameState.currentPlayerId) || null;
  return { hero, villain, live };
}

function heroPosition(hero, gameState) {
  if (!hero) return null;
  if (hero.seatIndex === gameState.dealerIndex) return 'BTN';
  if (hero.seatIndex === gameState.bbIndex) return 'BB';
  return null;
}

function pokerSkillCoverage({ holeCards, communityCards, gameState, players }) {
  if (!gameState || !VALID_STREETS.has(gameState.phase)) {
    return { supported: false, reason: 'unsupported_phase' };
  }
  if (gameState.handStartPlayerCount !== 2) {
    return { supported: false, reason: 'hand_not_started_heads_up' };
  }
  if (gameState.activePlayers !== 2 || gameState.totalPlayers !== 2) {
    return { supported: false, reason: 'not_heads_up_now' };
  }
  if (!Array.isArray(holeCards) || holeCards.length !== 2) {
    return { supported: false, reason: 'missing_hole_cards' };
  }
  if (gameState.phase !== 'preflop' && (!Array.isArray(communityCards) || communityCards.length < 3)) {
    return { supported: false, reason: 'missing_board' };
  }

  const { hero, villain, live } = findHeroAndVillain(players, gameState);
  if (!hero || !villain || live.length !== 2) {
    return { supported: false, reason: 'missing_heads_up_players' };
  }
  if (!heroPosition(hero, gameState)) {
    return { supported: false, reason: 'missing_button_or_blind_role' };
  }
  return { supported: true, reason: 'heads_up_supported' };
}

function pokerSkillLegalActions(gameState) {
  const currentBet = Number(gameState.currentBet || 0);
  const playerBet = Number(gameState.playerBet || 0);
  const chips = Number(gameState.chips || 0);
  const toCall = Math.max(0, currentBet - playerBet);
  const maxReachableTotal = playerBet + chips;
  const canRaise = chips > 0 && maxReachableTotal > currentBet;

  if (toCall > 0) {
    const actions = ['f', 'c'];
    if (canRaise) actions.push('b');
    return actions;
  }

  const actions = ['k'];
  if (canRaise) actions.push('b');
  return actions;
}

function loniceraLegalActions(gameState) {
  const currentBet = Number(gameState.currentBet || 0);
  const playerBet = Number(gameState.playerBet || 0);
  const chips = Number(gameState.chips || 0);
  const toCall = Math.max(0, currentBet - playerBet);
  const canRaise = chips > 0 && playerBet + chips > currentBet;

  if (toCall > 0) {
    const actions = ['fold', 'call'];
    if (canRaise) actions.push('raise', 'allin');
    return actions;
  }

  const actions = ['check'];
  if (canRaise) actions.push('raise', 'allin');
  return actions;
}

function actionToToken(action, bigBlind) {
  if (!action) return null;
  switch (action.action) {
    case 'raise':
    case 'allin':
      return `b${amountToken(action.playerBetAfterAction || action.amount || 0, bigBlind)}`;
    case 'call':
      return 'c';
    case 'check':
      return 'k';
    case 'fold':
      return 'f';
    default:
      return null;
  }
}

function buildPreflopActionTokens(gameState) {
  return (gameState.handActionLog || [])
    .filter((action) => action.phase === 'preflop')
    .map((action) => actionToToken(action, gameState.bigBlind))
    .filter(Boolean);
}

function describeAction(action, bigBlind) {
  switch (action.action) {
    case 'raise':
      return `raise to ${amountToken(action.playerBetAfterAction || action.amount || 0, bigBlind)}BB`;
    case 'allin':
      return `all-in to ${amountToken(action.playerBetAfterAction || action.amount || 0, bigBlind)}BB`;
    case 'call':
      return `call ${amountToken(action.contribution || action.amount || 0, bigBlind)}BB`;
    case 'check':
      return 'check';
    case 'fold':
      return 'fold';
    default:
      return String(action.action || 'unknown');
  }
}

function actorLabel(action, players, gameState) {
  const player = (players || []).find((candidate) => candidate.id === action.playerId);
  if (!player) return 'unknown';
  if (player.seatIndex === gameState.dealerIndex) return 'BTN';
  if (player.seatIndex === gameState.bbIndex) return 'BB';
  return player.name || player.id;
}

function buildReadableActionHistory(gameState, players) {
  const grouped = new Map();
  for (const action of gameState.handActionLog || []) {
    if (!grouped.has(action.phase)) grouped.set(action.phase, []);
    grouped.get(action.phase).push(
      `${actorLabel(action, players, gameState)} ${describeAction(action, gameState.bigBlind)}`
    );
  }
  return [...grouped.entries()].map(([phase, actions]) => `${phase}: ${actions.join(' -> ')}`);
}

function buildPokerSkillRequest({
  profile,
  holeCards,
  communityCards,
  gameState,
  players = [],
}) {
  const coverage = pokerSkillCoverage({ holeCards, communityCards, gameState, players });
  if (!coverage.supported) {
    return { coverage };
  }

  const { hero, villain } = findHeroAndVillain(players, gameState);
  const bigBlind = Math.max(1, Number(gameState.bigBlind || 0));
  const currentBet = Number(gameState.currentBet || 0);
  const playerBet = Number(gameState.playerBet || 0);
  const chips = Number(gameState.chips || 0);
  const maxRaiseTo = playerBet + chips;
  const minRaiseToRaw = Number(gameState.minRaise || currentBet || bigBlind);
  const minRaiseTo = Math.min(Math.max(minRaiseToRaw, currentBet || bigBlind), maxRaiseTo);

  return {
    coverage,
    modelContext: 'pokerskill_hunl',
    handId: gameState.roundCount || null,
    street: gameState.phase,
    heroHoleCards: (holeCards || []).map(cardCode),
    boardCards: (communityCards || []).map(cardCode),
    heroPosition: heroPosition(hero, gameState),
    potBb: chipsToBb(gameState.pot, bigBlind),
    totalPotBb: chipsToBb(gameState.pot, bigBlind),
    heroStackBb: chipsToBb(chips, bigBlind),
    villainStackBb: chipsToBb(villain?.chips || 0, bigBlind),
    currentBetBb: chipsToBb(currentBet, bigBlind),
    playerBetBb: chipsToBb(playerBet, bigBlind),
    toCallBb: chipsToBb(Math.max(0, currentBet - playerBet), bigBlind),
    minRaiseToBb: chipsToBb(minRaiseTo, bigBlind),
    maxRaiseToBb: chipsToBb(maxRaiseTo, bigBlind),
    bigBlind,
    legalActions: loniceraLegalActions(gameState),
    pokerSkillLegalActions: pokerSkillLegalActions(gameState),
    actionHistoryTokens: buildPreflopActionTokens(gameState),
    actionHistoryText: buildReadableActionHistory(gameState, players),
    persona: {
      name: profile?.name || null,
      style: profile?.style || 'balanced',
      aggression: profile?.aggression ?? null,
      bluffFreq: profile?.bluffFreq ?? null,
    },
  };
}

function normalizeActionName(action) {
  const normalized = String(action || '').trim().toLowerCase();
  if (normalized === 'f' || normalized === 'fold') return 'fold';
  if (normalized === 'k' || normalized === 'check') return 'check';
  if (normalized === 'c' || normalized === 'call') return 'call';
  if (['b', 'bet', 'raise'].includes(normalized)) return 'raise';
  if (['allin', 'all-in', 'all_in'].includes(normalized)) return 'allin';
  return null;
}

function validatePokerSkillResponse(response, requestPayload) {
  if (!response || typeof response !== 'object') {
    return { ok: false, reason: 'invalid_response_shape' };
  }

  const action = normalizeActionName(response.action || response.selectedAction);
  if (!action) return { ok: false, reason: 'invalid_action' };

  const gameState = {
    currentBet: requestPayload.currentBetBb * requestPayload.bigBlind,
    playerBet: requestPayload.playerBetBb * requestPayload.bigBlind,
    chips: requestPayload.heroStackBb * requestPayload.bigBlind,
    minRaise: requestPayload.minRaiseToBb * requestPayload.bigBlind,
  };
  const currentBet = Number(gameState.currentBet || 0);
  const playerBet = Number(gameState.playerBet || 0);
  const chips = Number(gameState.chips || 0);
  const toCall = Math.max(0, currentBet - playerBet);
  const maxReachableTotal = playerBet + chips;

  if (action === 'check') {
    return toCall > 0
      ? { ok: false, reason: 'check_facing_bet' }
      : { ok: true, decision: { action: 'check', _pokerskill: true } };
  }

  if (action === 'call') {
    return {
      ok: true,
      decision: { action: toCall > 0 ? 'call' : 'check', _pokerskill: true },
    };
  }

  if (action === 'fold') {
    return toCall > 0
      ? { ok: true, decision: { action: 'fold', _pokerskill: true } }
      : { ok: false, reason: 'fold_without_bet' };
  }

  if (action === 'allin') {
    return chips > 0
      ? { ok: true, decision: { action: 'allin', _pokerskill: true } }
      : { ok: false, reason: 'allin_without_chips' };
  }

  if (maxReachableTotal <= currentBet || chips <= 0) {
    return { ok: false, reason: 'raise_unavailable' };
  }

  const rawAmount =
    response.amount !== undefined && response.amount !== null
      ? Number(response.amount)
      : Number(response.amountBb || response.betBb || response.raiseToBb || 0) * requestPayload.bigBlind;
  const minRaiseTo = Number(gameState.minRaise || currentBet || requestPayload.bigBlind);
  if (maxReachableTotal < minRaiseTo) {
    return { ok: true, decision: { action: 'allin', _pokerskill: true } };
  }
  const requestedTotal = Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : minRaiseTo;
  const amount = Math.round(Math.max(minRaiseTo, Math.min(requestedTotal, maxReachableTotal)));
  if (amount >= maxReachableTotal) {
    return { ok: true, decision: { action: 'allin', _pokerskill: true } };
  }
  if (amount <= currentBet) {
    return {
      ok: true,
      decision: { action: toCall > 0 ? 'call' : 'check', _pokerskill: true },
    };
  }
  return { ok: true, decision: { action: 'raise', amount, _pokerskill: true } };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  buildPokerSkillRequest,
  defaultPokerSkillConfig,
  pokerSkillCoverage,
  requestPokerSkillDecision,
  validatePokerSkillResponse,
};
