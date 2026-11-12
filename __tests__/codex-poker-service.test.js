const {
  buildCodexPrompt,
  decide,
  normalizeAction,
  parseCodexDecision,
} = require('../ai/codex_poker_service');

describe('codex poker service helpers', () => {
  test('builds a prompt with heads-up state and JSON-only instruction', () => {
    const prompt = buildCodexPrompt({
      street: 'flop',
      heroPosition: 'BTN',
      heroHoleCards: ['As', 'Kd'],
      boardCards: ['Ah', '7d', '2c'],
      potBb: 5.5,
      heroStackBb: 47.5,
      villainStackBb: 48,
      currentBetBb: 0,
      playerBetBb: 0,
      toCallBb: 0,
      minRaiseToBb: 1,
      maxRaiseToBb: 47.5,
      legalActions: ['check', 'raise', 'allin'],
      actionHistoryText: ['preflop: BTN raise to 2.5BB -> BB call 1.5BB'],
      persona: { name: 'Bot', style: 'balanced' },
    });

    expect(prompt).toContain('Return only JSON');
    expect(prompt).toContain('Hero cards: As Kd');
    expect(prompt).toContain('Board: Ah 7d 2c');
    expect(prompt).toContain('Legal actions: check, raise, allin');
  });

  test('normalizes and parses codex action output', () => {
    expect(normalizeAction('all-in')).toBe('allin');
    expect(parseCodexDecision('{"action":"raise","amountBb":3.5}')).toEqual({
      action: 'raise',
      amountBb: 3.5,
    });
  });

  test('dry-run decision uses legal passive action shape', async () => {
    await expect(decide({ toCallBb: 1 }, { dryRun: true })).resolves.toMatchObject({
      ok: true,
      action: 'call',
      amountBb: null,
      modelVersion: 'codex-cli-dry-run',
    });
    await expect(decide({ toCallBb: 0 }, { dryRun: true })).resolves.toMatchObject({
      ok: true,
      action: 'check',
      amountBb: null,
    });
  });
});


test('HTTP failures do not expose local paths or process diagnostics', async () => {
  const { createServer } = require('../ai/codex_poker_service');
  const server = createServer({ codexBin: 'lonicera-missing-test-command', timeoutMs: 1000 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toCallBb: 0 }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'decision_failed' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
