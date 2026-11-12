const {
  buildPokerSkillRequest,
  pokerSkillCoverage,
  validatePokerSkillResponse,
} = require('../pokerskill-client');

function card(rank, suit, value) {
  return { rank, suit, value };
}

function headsUpFixture(overrides = {}) {
  const players = [
    {
      id: 'hero',
      name: 'HeroBot',
      seatIndex: 0,
      chips: 990,
      bet: 10,
      folded: false,
      allIn: false,
      isNPC: true,
    },
    {
      id: 'villain',
      name: 'Human',
      seatIndex: 1,
      chips: 980,
      bet: 20,
      folded: false,
      allIn: false,
      isNPC: false,
    },
  ];
  const gameState = {
    pot: 30,
    currentBet: 20,
    playerBet: 10,
    chips: 990,
    minRaise: 40,
    phase: 'preflop',
    roundCount: 7,
    activePlayers: 2,
    totalPlayers: 2,
    currentPlayerId: 'hero',
    dealerIndex: 0,
    bbIndex: 1,
    handStartPlayerCount: 2,
    handActionLog: [],
    bigBlind: 20,
    ...overrides.gameState,
  };
  return {
    players: overrides.players || players,
    gameState,
    holeCards: [card('A', 'spades', 14), card('K', 'diamonds', 13)],
    communityCards: overrides.communityCards || [],
  };
}

describe('pokerskill client', () => {
  test('builds a heads-up PokerSkill request in big-blind units', () => {
    const fixture = headsUpFixture();
    const payload = buildPokerSkillRequest({
      profile: { name: 'HeroBot', style: 'balanced' },
      ...fixture,
    });

    expect(payload.coverage).toMatchObject({ supported: true });
    expect(payload).toMatchObject({
      street: 'preflop',
      heroHoleCards: ['As', 'Kd'],
      heroPosition: 'BTN',
      potBb: 1.5,
      heroStackBb: 49.5,
      villainStackBb: 49,
      toCallBb: 0.5,
      minRaiseToBb: 2,
      maxRaiseToBb: 50,
      pokerSkillLegalActions: ['f', 'c', 'b'],
    });
  });

  test('rejects hands that did not start heads-up', () => {
    const fixture = headsUpFixture({ gameState: { handStartPlayerCount: 3 } });
    expect(pokerSkillCoverage(fixture)).toMatchObject({
      supported: false,
      reason: 'hand_not_started_heads_up',
    });
  });

  test('converts PokerSkill raise amount back to lonicera chips', () => {
    const fixture = headsUpFixture();
    const payload = buildPokerSkillRequest({
      profile: { name: 'HeroBot', style: 'balanced' },
      ...fixture,
    });

    const validated = validatePokerSkillResponse(
      { action: 'raise', amountBb: 3.25, modelVersion: 'dry' },
      payload
    );

    expect(validated).toMatchObject({
      ok: true,
      decision: { action: 'raise', amount: 65, _pokerskill: true },
    });
  });
});


test('client round-trips a decision through the dry-run HTTP service', async () => {
  const { createServer } = require('../ai/codex_poker_service');
  const { requestPokerSkillDecision } = require('../pokerskill-client');
  const server = createServer({ dryRun: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const payload = buildPokerSkillRequest({ profile: {}, ...headsUpFixture() });
    const response = await requestPokerSkillDecision({
      url: `http://127.0.0.1:${server.address().port}`, payload, timeoutMs: 1000,
    });
    expect(validatePokerSkillResponse(response, payload)).toMatchObject({
      ok: true, decision: { action: 'call', _pokerskill: true },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a stalled HTTP request aborts within the configured timeout', async () => {
  const { requestPokerSkillDecision } = require('../pokerskill-client');
  const server = require('http').createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await expect(requestPokerSkillDecision({
      url: `http://127.0.0.1:${server.address().port}`, payload: {}, timeoutMs: 50,
    })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
