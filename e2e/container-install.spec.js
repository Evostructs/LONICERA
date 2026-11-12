const { test, expect } = require('@playwright/test');
test('published container serves the UI and starts practice with built-in NPCs', async ({ page }) => {
  test.skip(!process.env.CONTAINER_URL, 'Requires a running container');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.CONTAINER_URL);
  await expect.poll(() => page.locator('.room-card').count()).toBeGreaterThanOrEqual(8);
  await page.fill('#playerName', 'ContainerTester');
  await page.click('#modeBtn_practice');
  await page.click('#btnTakeASeat');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/);
  await expect(page.locator('#modeBadge')).toHaveText('Practice');
  await page.click('#btnStartGame');
  await expect.poll(() => page.evaluate(() => gameState && gameState.roundCount)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => gameState.players.filter((p) => p.isNPC).length)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
