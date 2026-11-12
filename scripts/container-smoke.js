const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const base = process.env.CONTAINER_URL || 'http://127.0.0.1:2026';
const roomId = 'ContainerSmoke';
function event(socket, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`Timeout: ${name}`)); }, 15000);
    function listener(value) { if (predicate(value)) { clearTimeout(timer); socket.off(name, listener); resolve(value); } }
    socket.on(name, listener);
  });
}
async function main() {
  const status = await fetch(`${base}/api/status`);
  assert.equal(status.status, 200);
  if (process.argv.includes('--saved-only')) {
    const saves = await (await fetch(`${base}/api/saves`)).json();
    assert(saves.some((s) => s.roomId === roomId && s.roundCount >= 1));
    console.log('Persisted game save survived container replacement');
    return;
  }
  const clients = [0, 1].map(() => io(base, { autoConnect: false, reconnection: false, transports: ['websocket'] }));
  try {
    for (const [index, socket] of clients.entries()) {
      const connected = event(socket, 'connect'); socket.connect(); await connected;
      const joined = event(socket, 'joinedRoom');
      socket.emit('joinRoom', { roomId, playerName: `Player${index}`, npcCount: 0, startChips: 1000, smallBlind: 10, gameMode: 'cash' });
      await joined;
    }
    const finished = event(clients[0], 'gameState', (s) => s.phase === 'showdown');
    for (const socket of clients) socket.on('gameState', (s) => {
      if (s.isMyTurn) socket.emit('action', { action: 'call' });
    });
    clients[0].emit('startGame', { force: true });
    const state = await finished;
    assert.equal(state.roundCount, 1);
    assert.equal(state.communityCards.length, 5);
    const saved = event(clients[0], 'gameSaved'); clients[0].emit('saveGame'); await saved;
    console.log('Two players completed a full hand and saved it through the container');
  } finally { for (const socket of clients) socket.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
