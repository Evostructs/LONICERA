// server.js - Main poker server
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const random = require('./random');
const { PokerGame } = require('./engine');
const { saveGame, loadGame, deleteSave, listSaves } = require('./save-manager');
const { getNPCByName, NPC_PROFILES } = require('./npc');
const { Tournament } = require('./tournament');
const { loadLocalEnv } = require('./server/load-env');
const { loadConfig } = require('./server/config');
const { applySecurityHeaders, createRateLimiter } = require('./server/http-middleware');
const { createHostManager } = require('./server/host-manager');
const { registerSocketHandlers } = require('./server/socket-handlers');
const { computeAssetVersion, renderIndexTemplate } = require('./server/asset-version');
const { createStructuredLogger } = require('./server/logger');

loadLocalEnv(__dirname);
const config = loadConfig();
const structuredLog = createStructuredLogger('server', config.logLevel);
const SERVER_TEXT_LOGS = process.env.SERVER_TEXT_LOGS === '1';

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.socketCorsOrigin },
  pingTimeout: 120000, // 2 min: allow mobile background
  pingInterval: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 120000, // 2 min state recovery window
  },
});

// ── Session token store: socketId → { token, roomId, playerName } ──
const sessionTokens = new Map(); // token → { socketId, roomId, playerName }

function sanitizeName(value, maxLength = 16) {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/[^\p{L}\p{N} ._'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated = [...cleaned].slice(0, maxLength).join('').trim();
  if (!/[\p{L}\p{N}]/u.test(truncated)) return '';
  return truncated;
}

function normalizeNameKey(value) {
  return sanitizeName(value).toLocaleLowerCase();
}

function sanitizeAvatar(value) {
  if (typeof value !== 'string') return '🧑';
  const cleaned = value.trim().replace(/[<>&"'`]/g, '');
  return [...cleaned].slice(0, 4).join('') || '🧑';
}

// Do not set HSTS or upgrade-insecure-requests here: NAS/LAN deployments commonly use plain HTTP.
app.use(applySecurityHeaders);

// Global error handlers — prevent server crash on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught Exception:', err.message);
  console.error(err.stack);
  structuredLog({
    level: 'error',
    event: 'uncaught_exception',
    message: 'Unhandled server exception',
    data: { error: err.message, stack: err.stack },
  });
});
process.on('unhandledRejection', (reason) => {
  console.error('🔥 Unhandled Rejection:', reason);
  structuredLog({
    level: 'error',
    event: 'unhandled_rejection',
    message: 'Unhandled promise rejection',
    data: { reason: String(reason) },
  });
});

// Room ID validation regex: alphanumeric, Chinese characters, underscores, 1-20 chars
const ROOM_ID_REGEX = /^[\w\u4e00-\u9fff]{1,20}$/;

// Serve static files
const publicDir = path.join(__dirname, 'public');
const assetVersion = computeAssetVersion(__dirname);
const renderedIndexHtml = renderIndexTemplate(__dirname, assetVersion);

app.get(['/', '/index.html'], (req, res) => {
  res.type('html').send(renderedIndexHtml);
});

app.use(express.static(publicDir));
app.use('/api', createRateLimiter({ limit: config.httpRateLimit, windowMs: config.httpRateWindow }));

// Preflop lookup table (built in background at startup)
let preflopTable = null;
let preflopTableReady = false;

function buildTableInBackground() {
  if (!config.preflopTableEnabled || config.preflopSims === 0) {
    structuredLog({
      level: 'info',
      event: 'preflop_table_skipped',
      message: 'Preflop table build skipped',
      data: { preflopTableEnabled: config.preflopTableEnabled, preflopSims: config.preflopSims },
    });
    return;
  }
  structuredLog({
    level: 'info',
    event: 'preflop_table_build_started',
    message: 'Preflop table build started',
    data: { preflopSims: config.preflopSims },
  });
  const startTime = Date.now();

  const { Worker } = require('worker_threads');
  const worker = new Worker(path.join(__dirname, 'preflop-worker.js'), {
    workerData: { sims: config.preflopSims },
  });

  worker.on('message', (msg) => {
    if (msg.type === 'progress') {
      if (SERVER_TEXT_LOGS) {
        const pct = ((msg.done / msg.total) * 100).toFixed(0);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        process.stdout.write(
          `\r   Progress: ${pct}% (${msg.done}/${msg.total} hand types) - ${elapsed}s`
        );
      }
    } else if (msg.type === 'done') {
      preflopTable = msg.table;
      preflopTableReady = true;
      const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      if (SERVER_TEXT_LOGS) {
        console.log(
          `\n✅ Preflop table ready! (${totalTime} min) - NPC preflop decisions now use precise equity.`
        );
      }
      structuredLog({
        level: 'info',
        event: 'preflop_table_ready',
        message: 'Preflop table build complete',
        data: { totalMinutes: Number(totalTime) },
      });

      // Inject into all existing games
      for (const [id, game] of games) {
        game.preflopTable = preflopTable;
      }
    }
  });

  worker.on('error', (err) => {
    if (SERVER_TEXT_LOGS) {
      console.error('\n⚠️ Preflop table build failed:', err.message);
      console.log('   NPC will continue using heuristic preflop evaluation.');
    }
    structuredLog({
      level: 'error',
      event: 'preflop_table_failed',
      message: 'Preflop table build failed',
      data: { error: err.message },
    });
  });
}

const games = new Map();
const hostManager = createHostManager({
  games,
  io,
  graceMs: config.hostTransferGraceMs,
});
const { assignHost, clearHostTransferTimer, requireHost, scheduleHostTransfer } = hostManager;

function getOrCreateGame(roomId, options = {}) {
  if (!games.has(roomId)) {
    if (games.size >= config.maxRooms) return null;
    const game = new PokerGame(roomId, {
      ...options,
      solverDataDir: options.solverDataDir || config.solverDataDir,
      solverRootCacheDir: options.solverRootCacheDir || config.solverRootCacheDir,
      npcModel: options.npcModel || config.npcModel,
      pokerSkill: options.pokerSkill || config.pokerSkill,
    });
    if (preflopTable) game.preflopTable = preflopTable;
    game.onUpdate = (g) => {
      assignHost(g);
      for (const p of g.players) {
        if (!p.isNPC) {
          io.to(p.id).emit('gameState', g.getStateForPlayer(p.id));
        }
      }
      // Practice mode: auto-push equity on community card change
      if (g.gameMode === 'practice' && g.isRunning) {
        const ccLen = g.communityCards.length;
        if (g._lastAutoEqCCLen !== ccLen) {
          g._lastAutoEqCCLen = ccLen;
          setImmediate(() => {
            for (const p of g.players) {
              if (!p.isNPC && p.holeCards && p.holeCards.length === 2 && !p.folded) {
                const eqResult = g.calculateEquity(p.id);
                if (eqResult !== null) io.to(p.id).emit('autoEquity', eqResult);
              }
            }
          });
        }
      }
    };
    game.onMessage = (msg) => {
      io.to(roomId).emit('gameMessage', msg);
    };
    game.onChat = (senderName, message) => {
      io.to(roomId).emit('chatMessage', {
        sender: senderName,
        message: message,
        time: Date.now(),
      });
    };

    // Auto-advance: after each round, automatically start next round after delay
    game.onRoundEnd = (g, tournamentResult) => {
      if (tournamentResult) {
        io.to(roomId).emit('tournamentEnd', tournamentResult);
        return;
      }
      if (g.gameOver) {
        if (g._autoTimer) {
          clearTimeout(g._autoTimer);
          g._autoTimer = null;
        }
        return;
      }
      // Cash: remove busted NPCs, keep humans
      if (!g.tournament || !g.tournament.isActive) {
        g.players = g.players.filter((p) => p.chips > 0 || !p.isNPC);
      } else {
        // Tournament: remove busted NPCs only, keep humans as spectators
        g.players = g.players.filter((p) => p.chips > 0 || !p.isNPC);
        // Mark busted humans as folded spectators
        g.players
          .filter((p) => !p.isNPC && p.chips <= 0)
          .forEach((p) => {
            p.folded = true;
          });
      }
      g.players.forEach((p, i) => (p.seatIndex = i));

      // Check enough players
      if (g.players.filter((p) => p.chips > 0).length < 2) return;

      // Auto-start next round (practice mode uses shorter delay)
      if (g._autoTimer) clearTimeout(g._autoTimer);
      const baseDelay = g.gameMode === 'practice' ? 2500 : 5000;
      const autoDelay = baseDelay / (g.speedMultiplier || 1);
      g._autoTimer = setTimeout(() => {
        if (!g.isRunning && !g.isPaused && g.players.filter((p) => p.chips > 0).length >= 2) {
          g.startRound();
        }
      }, autoDelay);
    };

    // Try to restore from save
    const save = loadGame(roomId);
    if (save) {
      game.smallBlind = save.settings.smallBlind;
      game.bigBlind = save.settings.bigBlind;
      game.startChips = save.settings.startChips;
      game.roundCount = save.roundCount || 0;
      game.dealerIndex = save.dealerIndex || 0;
      if (save.gameMode) game.gameMode = save.gameMode;

      // Restore NPC players
      for (const sp of save.players) {
        if (sp.isNPC && sp.npcProfileName) {
          const profile = getNPCByName(sp.npcProfileName);
          if (profile) {
            const p = game.addPlayer({
              id: random.randomId('npc_'),
              name: sp.name,
              isNPC: true,
              npcProfile: profile,
            });
            if (p) {
              p.chips = sp.chips;
              p.wins = sp.wins || 0;
              p.handsPlayed = sp.handsPlayed || 0;
            }
          }
        }
      }

      // Restore leaderboard
      if (save.leaderboard) {
        game.leaderboard.stats = save.leaderboard;
      }

      structuredLog({
        level: 'info',
        event: 'save_restored',
        roomId,
        message: 'Room restored from save',
        data: {
          playerCount: save.players.length,
          roundCount: save.roundCount || 0,
          gameMode: save.gameMode || game.gameMode,
        },
      });
    }

    games.set(roomId, game);
  }
  return games.get(roomId);
}

// API endpoint to list rooms
app.get('/api/rooms', (req, res) => {
  const rooms = [];
  for (const [id, game] of games) {
    // Practice mode rooms hidden from lobby
    if (game.gameMode === 'practice') continue;
    rooms.push({
      id,
      players: game.players.length,
      maxPlayers: game.maxPlayers,
      humanCount: game.players.filter((player) => !player.isNPC).length,
      npcCount: game.players.filter((player) => player.isNPC).length,
      isRunning: game.isRunning,
      smallBlind: game.smallBlind,
      bigBlind: game.bigBlind,
      startChips: game.startChips,
      gameMode: game.gameMode || 'cash',
    });
  }
  res.json(rooms);
});

// API endpoint to check server status
app.get('/api/status', (req, res) => {
  res.json({
    preflopTableReady: preflopTableReady,
    preflopTableEnabled: config.preflopTableEnabled,
    preflopSimulations: config.preflopSims,
    activeRooms: games.size,
  });
});

// API endpoint to list saves
app.get('/api/saves', (req, res) => {
  res.json(listSaves());
});

registerSocketHandlers({
  io,
  games,
  sessionTokens,
  maxWsConnections: config.maxWsConnections,
  sanitizeName,
  normalizeNameKey,
  sanitizeAvatar,
  roomIdRegex: ROOM_ID_REGEX,
  getOrCreateGame,
  loadGame,
  saveGame,
  deleteSave,
  listSaves,
  getNPCByName,
  NPC_PROFILES,
  Tournament,
  assignHost,
  clearHostTransferTimer,
  requireHost,
  scheduleHostTransfer,
  checkAndResetRoom,
});
// Reset room when all human players are gone
function checkAndResetRoom(roomId) {
  if (!games.has(roomId)) return;
  const g = games.get(roomId);
  const humansLeft = g.players.filter((p) => !p.isNPC);
  if (humansLeft.length === 0) {
    // All humans gone → nuke the room
    clearHostTransferTimer(g);
    if (g._autoTimer) {
      clearTimeout(g._autoTimer);
      g._autoTimer = null;
    }
    if (g.tournament) {
      g.tournament.stop();
      g.tournament = null;
    }
    g.stop(); // Stop engine and NPC timers
    // Clean up all session tokens for this room
    for (const [token, session] of sessionTokens) {
      if (session.roomId === roomId) sessionTokens.delete(token);
    }
    games.delete(roomId);
    structuredLog({
      level: 'info',
      event: 'room_cleaned',
      roomId,
      message: 'Room cleaned after all humans left',
      data: { reason: 'all_humans_left' },
    });
    return;
  }
  // Also check if no humans connected (all disconnected)
  const connectedHumans = humansLeft.filter((p) => p.isConnected);
  if (connectedHumans.length === 0) {
    clearHostTransferTimer(g);
    if (g._autoTimer) {
      clearTimeout(g._autoTimer);
      g._autoTimer = null;
    }
    if (g.tournament) {
      g.tournament.stop();
      g.tournament = null;
    }
    g.stop(); // Stop engine and NPC timers
    for (const [token, session] of sessionTokens) {
      if (session.roomId === roomId) sessionTokens.delete(token);
    }
    games.delete(roomId);
    structuredLog({
      level: 'info',
      event: 'room_cleaned',
      roomId,
      message: 'Room cleaned after all humans disconnected',
      data: { reason: 'all_humans_disconnected' },
    });
  }
}

function startServer(options = {}) {
  const port = options.port !== undefined ? options.port : config.port;
  const host = options.host || config.host;
  const shouldBuildPreflop = options.buildPreflop !== false;
  const unrefServer = options.unrefServer === true;

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      if (unrefServer && typeof server.unref === 'function') server.unref();
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      if (SERVER_TEXT_LOGS) {
        console.log(`
╔══════════════════════════════════════════════╗
║    ♠ LONICERA v1.0 ♠                        ║
║    Running on ${host}:${actualPort}                    ║
║    Open http://localhost:${actualPort} to play         ║
║    For entertainment & education only        ║
╚══════════════════════════════════════════════╝
  `);
      }
      structuredLog({
        level: 'info',
        event: 'server_started',
        message: 'LONICERA server started',
        data: {
          host,
          port: actualPort,
          assetVersion,
          preflopTableEnabled: config.preflopTableEnabled,
          preflopSims: config.preflopSims,
        },
      });

      if (shouldBuildPreflop) buildTableInBackground();
      resolve({ app, server, io, games, sessionTokens, config });
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  server,
  io,
  games,
  sessionTokens,
  startServer,
  config,
  sanitizeName,
  normalizeNameKey,
};
