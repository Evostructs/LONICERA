const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');

jest.setTimeout(15000);

const Card = (suit, value) => ({
  suit,
  value,
  rank: {
    2: '2',
    3: '3',
    4: '4',
    5: '5',
    6: '6',
    7: '7',
    8: '8',
    9: '9',
    10: '10',
    11: 'J',
    12: 'Q',
    13: 'K',
    14: 'A',
  }[value],
});

describe('Socket.IO room flow', () => {
  const originalEnv = { ...process.env };
  const clients = [];
  let baseUrl;
  let serverModule;
  let tempDir;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lonicera-socket-'));
    process.env.PREFLOP_TABLE = 'off';
    process.env.SAVE_DIR = tempDir;
    process.env.HOST_TRANSFER_GRACE_MS = '200';
    process.env.HTTP_RATE_LIMIT = '1000';
    process.env.HOST = '127.0.0.1';
    jest.resetModules();
    serverModule = require('../server');
    await serverModule.startServer({
      port: 0,
      host: '127.0.0.1',
      buildPreflop: false,
      unrefServer: true,
    });
    baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
  });

  afterEach(async () => {
    while (clients.length) {
      const socket = clients.pop();
      if (!socket) continue;
      socket.removeAllListeners();
      socket.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (const game of serverModule.games.values()) game.stop();
  });

  afterAll(async () => {
    await new Promise((resolve) => serverModule.io.close(resolve));
    if (typeof serverModule.server.closeIdleConnections === 'function') {
      serverModule.server.closeIdleConnections();
    }
    if (typeof serverModule.server.closeAllConnections === 'function') {
      serverModule.server.closeAllConnections();
    }
    if (serverModule.server.listening) {
      await new Promise((resolve) => serverModule.server.close(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function connectClient() {
    return new Promise((resolve, reject) => {
      const socket = Client(baseUrl, {
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
      });
      clients.push(socket);
      const timer = setTimeout(() => {
        reject(new Error('Socket connect timeout'));
      }, 2000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function waitFor(socket, eventName, predicate = () => true, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${eventName}`));
      }, timeoutMs);
      const handler = (payload) => {
        if (!predicate(payload)) return;
        cleanup();
        resolve(payload);
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off(eventName, handler);
      };
      socket.on(eventName, handler);
    });
  }

  function joinRoom(socket, payload) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('joinRoom timeout'));
      }, 3000);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('joinedRoom', onJoined);
        socket.off('error', onError);
      };
      const onJoined = (data) => {
        cleanup();
        resolve(data);
      };
      const onError = (data) => {
        cleanup();
        reject(new Error(data && data.message ? data.message : 'joinRoom failed'));
      };
      socket.once('joinedRoom', onJoined);
      socket.once('error', onError);
      socket.emit('joinRoom', {
        roomId: `r_${Date.now()}`,
        playerName: 'Alice',
        npcCount: 0,
        smallBlind: 10,
        startChips: 1000,
        playerAvatar: 'A',
        gameMode: 'cash',
        ...payload,
      });
    });
  }

  test('joins a room and reconnects only with the session token', async () => {
    const roomId = `rejoin_${Date.now()}`;
    const first = await connectClient();
    const joined = await joinRoom(first, { roomId, playerName: 'Alice' });

    expect(joined.state).toMatchObject({ hostName: 'Alice', isHost: true });
    expect(joined.sessionToken).toBeTruthy();

    first.disconnect();
    const second = await connectClient();
    const rejoined = await joinRoom(second, {
      roomId,
      playerName: 'Alice',
      sessionToken: joined.sessionToken,
    });

    expect(rejoined.state.players.filter((p) => !p.isNPC)).toHaveLength(1);
    expect(rejoined.state).toMatchObject({ hostName: 'Alice', isHost: true });
  });

  test('sanitizes human names and blocks normalized duplicates in the same room', async () => {
    const roomId = `names_${Date.now()}`;
    const first = await connectClient();
    const second = await connectClient();

    const joined = await joinRoom(first, { roomId, playerName: "  Frost   Wolf!!__  " });
    const firstHuman = joined.state.players.find((player) => !player.isNPC);
    expect(firstHuman.name).toBe('Frost Wolf__');

    const duplicateJoin = joinRoom(second, { roomId, playerName: ' frost wolf__ ' });
    await expect(duplicateJoin).rejects.toThrow('Name already taken in this room');
  });

  test('practice mode always starts with at least one NPC', async () => {
    const roomId = `practice_${Date.now()}`;
    const player = await connectClient();
    const joined = await joinRoom(player, { roomId, gameMode: 'practice', npcCount: 0 });

    expect(joined.actualMode).toBe('practice');
    expect(joined.state.players.filter((playerEntry) => playerEntry.isNPC)).toHaveLength(1);
  });

  test('blocks non-host room management but allows the host', async () => {
    const roomId = `perm_${Date.now()}`;
    const host = await connectClient();
    const guest = await connectClient();
    await joinRoom(host, { roomId, playerName: 'Host', npcCount: 1 });
    await joinRoom(guest, { roomId, playerName: 'Guest' });

    const guestError = waitFor(
      guest,
      'error',
      (data) => data && data.message === 'Only the room host can do that'
    );
    guest.emit('startGame');
    await expect(guestError).resolves.toMatchObject({
      message: 'Only the room host can do that',
    });

    const runningState = waitFor(host, 'gameState', (state) => state && state.isRunning === true);
    host.emit('startGame', { force: true });
    await expect(runningState).resolves.toMatchObject({ isRunning: true });
  });

  test('requires human players to ready up before the host starts unless forced', async () => {
    const roomId = `ready_${Date.now()}`;
    const host = await connectClient();
    const guest = await connectClient();
    await joinRoom(host, { roomId, playerName: 'Host' });
    await joinRoom(guest, { roomId, playerName: 'Guest' });

    const notReadyError = waitFor(
      host,
      'error',
      (data) => data && data.message === 'Not all players are ready'
    );
    host.emit('startGame');
    await expect(notReadyError).resolves.toMatchObject({
      message: 'Not all players are ready',
    });

    const guestReady = waitFor(
      guest,
      'gameState',
      (state) =>
        state && state.players.find((player) => player.name === 'Guest' && player.isReady === true)
    );
    guest.emit('setReady', { ready: true });
    await expect(guestReady).resolves.toBeTruthy();

    const runningState = waitFor(host, 'gameState', (state) => state && state.isRunning === true);
    host.emit('startGame');
    await expect(runningState).resolves.toMatchObject({ isRunning: true });
  });

  test('allows the host to force start even if some human players are not ready', async () => {
    const roomId = `force_${Date.now()}`;
    const host = await connectClient();
    const guest = await connectClient();
    await joinRoom(host, { roomId, playerName: 'Host' });
    await joinRoom(guest, { roomId, playerName: 'Guest' });

    const runningState = waitFor(host, 'gameState', (state) => state && state.isRunning === true);
    host.emit('startGame', { force: true });
    await expect(runningState).resolves.toMatchObject({ isRunning: true });
  });

  test('auto-play guests are excluded from the ready gate', async () => {
    const roomId = `autoplay_ready_${Date.now()}`;
    const host = await connectClient();
    const guest = await connectClient();
    await joinRoom(host, { roomId, playerName: 'Host' });
    await joinRoom(guest, { roomId, playerName: 'Guest' });

    const guestAuto = waitFor(
      guest,
      'gameState',
      (state) =>
        state && state.players.find((player) => player.name === 'Guest' && player.autoPlay === true)
    );
    guest.emit('setAutoPlay', { enabled: true });
    await guestAuto;

    const runningState = waitFor(host, 'gameState', (state) => state && state.isRunning === true);
    host.emit('startGame');
    await expect(runningState).resolves.toMatchObject({ isRunning: true });
  });

  test('transfers host after disconnected host grace period', async () => {
    const roomId = `transfer_${Date.now()}`;
    const host = await connectClient();
    const guest = await connectClient();
    await joinRoom(host, { roomId, playerName: 'Host' });
    await joinRoom(guest, { roomId, playerName: 'Guest' });

    const transferred = waitFor(
      guest,
      'gameState',
      (state) => state && state.hostName === 'Guest' && state.isHost === true,
      5000
    );
    host.disconnect();

    await expect(transferred).resolves.toMatchObject({
      hostName: 'Guest',
      isHost: true,
    });
  });

  test('replay returns the completed previous hand while the next hand is active', async () => {
    const roomId = `replay_${Date.now()}`;
    const host = await connectClient();
    const guest = await connectClient();
    await joinRoom(host, { roomId, playerName: 'Host' });
    await joinRoom(guest, { roomId, playerName: 'Guest' });

    const runningState = waitFor(host, 'gameState', (state) => state && state.isRunning === true);
    host.emit('startGame', { force: true });
    await runningState;

    const game = serverModule.games.get(roomId);
    const hostPlayer = game.players.find((player) => player.name === 'Host');
    const guestPlayer = game.players.find((player) => player.name === 'Guest');
    hostPlayer.totalBet = 500;
    hostPlayer.chips = 500;
    guestPlayer.totalBet = 500;
    guestPlayer.chips = 500;
    game.pot = 1000;
    hostPlayer.holeCards = [Card('spades', 14), Card('diamonds', 13)];
    guestPlayer.holeCards = [Card('hearts', 2), Card('clubs', 7)];
    game.handHistory.current.holeCards[hostPlayer.id] = hostPlayer.holeCards.map((card) => ({
      ...card,
    }));
    game.handHistory.current.holeCards[guestPlayer.id] = guestPlayer.holeCards.map((card) => ({
      ...card,
    }));
    game.communityCards = [
      Card('hearts', 14),
      Card('spades', 13),
      Card('diamonds', 12),
      Card('clubs', 5),
      Card('hearts', 3),
    ];

    game.showdown();
    if (game._autoTimer) {
      clearTimeout(game._autoTimer);
      game._autoTimer = null;
    }
    game.startRound();

    const replayResponse = waitFor(
      host,
      'handReplay',
      (hand) => hand && hand.handNum === 1,
      4000
    );
    host.emit('getReplay', { handNum: 1 });

    await expect(replayResponse).resolves.toMatchObject({
      handNum: 1,
      communityCards: [
        expect.objectContaining({ suit: 'hearts', value: 14 }),
        expect.objectContaining({ suit: 'spades', value: 13 }),
        expect.objectContaining({ suit: 'diamonds', value: 12 }),
        expect.objectContaining({ suit: 'clubs', value: 5 }),
        expect.objectContaining({ suit: 'hearts', value: 3 }),
      ],
      holeCards: {
        [hostPlayer.id]: [
          expect.objectContaining({ suit: 'spades', value: 14 }),
          expect.objectContaining({ suit: 'diamonds', value: 13 }),
        ],
        [guestPlayer.id]: [
          expect.objectContaining({ suit: 'hearts', value: 2 }),
          expect.objectContaining({ suit: 'clubs', value: 7 }),
        ],
      },
    });
  });

  test('guests can ready for a rematch during game-over and keep it after restart', async () => {
    const roomId = `rm_${Date.now()}`;
    const host = await connectClient();
    const guest = await connectClient();
    await joinRoom(host, { roomId, playerName: 'Host' });
    await joinRoom(guest, { roomId, playerName: 'Guest' });

    const game = serverModule.games.get(roomId);
    const hostPlayer = game.players.find((player) => player.name === 'Host');
    const guestPlayer = game.players.find((player) => player.name === 'Guest');
    hostPlayer.chips = 2000;
    guestPlayer.chips = 0;
    game.isRunning = false;
    game.phase = 'showdown';
    game.roundCount = 1;
    game.gameOver = {
      reason: 'last-player-standing',
      winnerId: hostPlayer.id,
      winnerName: hostPlayer.name,
      remainingPlayers: 1,
    };
    game.emitUpdate(game);

    const guestReady = waitFor(
      guest,
      'gameState',
      (state) =>
        state &&
        state.gameOver &&
        state.players.find((player) => player.name === 'Guest' && player.isReady === true)
    );
    guest.emit('setReady', { ready: true });
    await guestReady;

    const restarted = waitFor(
      guest,
      'gameState',
      (state) =>
        state &&
        !state.gameOver &&
        state.roundCount === 0 &&
        state.players.find((player) => player.name === 'Guest' && player.isReady === true)
    );
    host.emit('restartGame');
    await expect(restarted).resolves.toBeTruthy();
  });

  test('equity requests reuse the cached result until the board state changes', async () => {
    const roomId = `equity_${Date.now()}`;
    const heroSocket = await connectClient();
    await joinRoom(heroSocket, {
      roomId,
      playerName: 'Hero',
      npcCount: 1,
      gameMode: 'cash',
    });

    const game = serverModule.games.get(roomId);
    const hero = game.players.find((player) => player.id === heroSocket.id);
    const villain = game.players.find((player) => player.isNPC);

    game.isRunning = true;
    game.phase = 'turn';
    game.communityCards = [Card('hearts', 10), Card('spades', 9), Card('diamonds', 8), Card('clubs', 7)];
    hero.folded = false;
    villain.folded = false;
    hero.holeCards = [Card('spades', 14), Card('clubs', 14)];
    villain.holeCards = [Card('diamonds', 13), Card('hearts', 13)];
    hero.chips = 200;
    game.equityState[hero.id] = { freeLeft: 3, priceLevel: 0, unusedStreak: 0 };

    const requestEquity = async () => {
      const equityResult = waitFor(heroSocket, 'equityResult');
      heroSocket.emit('requestEquity');
      return equityResult;
    };

    await expect(requestEquity()).resolves.toMatchObject({ cost: 0, freeLeft: 2, nextPrice: 20 });
    await expect(requestEquity()).resolves.toMatchObject({
      cost: 0,
      freeLeft: 2,
      nextPrice: 20,
      unchanged: true,
    });

    game.phase = 'river';
    game.communityCards.push(Card('hearts', 2));
    await expect(requestEquity()).resolves.toMatchObject({ cost: 0, freeLeft: 1, nextPrice: 20 });

    game.phase = 'turn';
    game.communityCards = [Card('hearts', 10), Card('spades', 9), Card('diamonds', 8), Card('clubs', 7)];
    game.roundCount += 1;
    await expect(requestEquity()).resolves.toMatchObject({ cost: 0, freeLeft: 0, nextPrice: 20 });

    game.phase = 'river';
    game.communityCards.push(Card('clubs', 2));
    await expect(requestEquity()).resolves.toMatchObject({ cost: 20, freeLeft: 0, nextPrice: 40 });

    game.phase = 'turn';
    game.communityCards = [Card('hearts', 10), Card('spades', 9), Card('diamonds', 8), Card('clubs', 7)];
    game.roundCount += 1;
    await expect(requestEquity()).resolves.toMatchObject({ cost: 40, freeLeft: 0, nextPrice: 80 });
  });
});
