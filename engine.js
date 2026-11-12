// engine.js - Texas Hold'em game engine
const { createDeck, shuffle } = require('./deck');
const { evaluateHand, compareHands, HAND_NAMES } = require('./hand-eval');
const { getAvailableNPCs, vanillaMC, rangeWeightedMC } = require('./npc');
const { decideNpcAction } = require('./npc-orchestrator');
const { estimateRange, boardConnectivity } = require('./range');
const { generateNPCChat } = require('./npc-chat');
const random = require('./random');
const { createStructuredLogger } = require('./server/logger');
const { buildSolverContext } = require('./solver-context');
const { warmStrategyTree } = require('./solver-lookup');
// Neural network NPC disabled — awaiting Deep CFR training
// const { neuralNpcDecision } = require('./npc-neural');
const { PlayerStats } = require('./player-stats');
const { NPCPsychology } = require('./npc-psychology');
const { HandHistory, Leaderboard } = require('./hand-history');
const { Tournament } = require('./tournament');

const PHASES = ['waiting', 'preflop', 'flop', 'turn', 'river', 'showdown'];

// ── Configuration Constants ──
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // 'debug' | 'info' | 'warn' | 'error'
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const GAMEPLAY_TEXT_LOGS = process.env.GAMEPLAY_TEXT_LOGS === '1';
const EQUITY_SIMS = 3000; // Monte Carlo iterations for equity calculation
const NPC_DELAY_MIN = 1500; // NPC decision delay range (ms)
const NPC_DELAY_MAX = 3000;
const PRACTICE_NEXT_DELAY = 2500; // Delay before next round in practice mode (ms)
const CASH_NEXT_DELAY = 5000; // Delay before next round in cash/tournament (ms)
const PRACTICE_ACTION_TIMEOUT_MS = 18000;
const TOURNAMENT_ACTION_TIMEOUT_MS = 25000;
const CASH_IDLE_TIMEOUT_MS = 90000;
const RUNTIME_ROLLOUT_LOG_EVERY = Math.max(
  1,
  Number.isFinite(Number(process.env.RUNTIME_ROLLOUT_LOG_EVERY))
    ? Number(process.env.RUNTIME_ROLLOUT_LOG_EVERY)
    : 50
);
const AUTO_PLAY_PROFILE = {
  name: 'Auto Play',
  style: 'balanced',
  tightness: 0.56,
  bluffFreq: 0.07,
  aggression: 0.54,
  cbetFreq: 0.58,
  checkRaiseFreq: 0.08,
};
const structuredEngineLog = createStructuredLogger('engine');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function incrementCounter(counterMap, key) {
  const normalizedKey = key || 'unknown';
  counterMap[normalizedKey] = (counterMap[normalizedKey] || 0) + 1;
}

class PokerGame {
  constructor(id, options = {}) {
    this.id = id;
    this.smallBlind = options.smallBlind || 10;
    this.bigBlind = options.bigBlind || 20;
    this.startChips = options.startChips || 1000;
    this.maxPlayers = options.maxPlayers || 8;
    this.players = [];
    this.deck = [];
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.phase = 'waiting';
    this.dealerIndex = 0;
    this.currentPlayerIndex = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.roundBets = {};
    this.lastRaiserIndex = -1;
    this.isRunning = false;
    this.actionTimeout = null;
    this.configuredActionTimeoutMs = options.actionTimeoutMs || 0;
    this.actionTimeoutMs = this.configuredActionTimeoutMs || 0;
    this.onUpdate = null;
    this.onMessage = null;
    this.npcModelConfig = options.npcModel || null;
    this.pokerSkillConfig = options.pokerSkill || null;
    this.solverDataDir = options.solverDataDir || null;
    this.solverRootCacheDir = options.solverRootCacheDir || null;

    // Player behavior tracking
    this.playerStats = new PlayerStats();
    this.npcPsychology = new NPCPsychology();
    this.handActionHistory = {};
    this.handActionLog = [];
    this.handStartPlayerCount = 0;
    this.handStartStacks = {};
    this.preflopRaiserId = null;
    this.runtimeRolloutStats = {
      decisions: 0,
      solverHits: 0,
      pokerSkillHits: 0,
      modelHits: 0,
      fallbacks: 0,
      coveredFallbacks: 0,
      lookupSources: {},
      fallbackReasons: {},
      solverReasons: {},
      solverClassifications: {},
      solverTakeoverModes: {},
      latencyMsTotal: 0,
      latencySamples: 0,
    };

    // Preflop lookup table (injected by server)
    this.preflopTable = null;

    // Winner tracking (authoritative, sent to client)
    this.lastRoundWinnerIds = [];
    this.lastRoundRefunds = [];
    this.sbIndex = -1;

    // Logging helpers
    const suitSymbol = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
    this._card = (c) => `${c.rank}${suitSymbol[c.suit] || c.suit}`;
    this._cards = (arr) => arr.map((c) => this._card(c)).join(' ');
    this._logEvent = (event, data = {}, level = 'info', message = '') => {
      structuredEngineLog({
        level,
        event,
        roomId: this.id,
        message,
        data: {
          phase: this.phase,
          roundCount: this.roundCount,
          pot: this.pot,
          ...data,
        },
      });
    };
    this._log = (msg, level = 'info') => {
      if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] < LOG_LEVELS[LOG_LEVEL]) return;
      if (!GAMEPLAY_TEXT_LOGS) {
        if (level === 'warn' || level === 'error') {
          this._logEvent('engine_diag', { detail: msg }, level, 'Engine diagnostic');
        }
        return;
      }
      const ts = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
      const humans =
        this.players
          .filter((p) => !p.isNPC)
          .map((p) => p.name)
          .join(',') || '-';
      console.log(`[${ts}] [room:${this.id}] [players:${humans}] ${msg}`);
    };
    this.bbIndex = -1;

    // Game mode, speed control, pause, equity state
    this.gameMode = options.gameMode || 'cash'; // 'cash' | 'tournament' | 'practice'
    this.speedMultiplier = 1; // 1=normal, 2=fast, 3=turbo
    this.isPaused = false;
    this._pausedNpcPending = false; // automated turn pending while paused
    this.equityState = {}; // per-player: { freeLeft, priceLevel, unusedStreak }
    this.equitySnapshots = {}; // per-player cached oracle result for unchanged board state

    // Hand history & leaderboard
    this.handHistory = new HandHistory();
    this.leaderboard = new Leaderboard();

    // Tournament mode
    this.tournament = null;
    this.roundCount = 0;
    this.gameOver = null;
    this.turnExpiresAt = null;
    this.turnDurationMs = 0;
  }

  recordRuntimeRolloutDecision(trace, solverTrace = null) {
    if (!trace || !['solver_hit', 'pokerskill_hit', 'model_hit', 'fallback'].includes(trace.status)) return;
    const stats = this.runtimeRolloutStats;
    stats.decisions += 1;

    if (trace.status === 'solver_hit') {
      stats.solverHits += 1;
      incrementCounter(stats.lookupSources, trace.lookupSource);
      incrementCounter(stats.solverReasons, trace.reason);
      incrementCounter(stats.solverClassifications, trace.classification);
      incrementCounter(stats.solverTakeoverModes, trace.takeoverMode);
    } else if (trace.status === 'pokerskill_hit') {
      stats.pokerSkillHits += 1;
    } else if (trace.status === 'model_hit') {
      stats.modelHits += 1;
    } else if (trace.status === 'fallback') {
      stats.fallbacks += 1;
      incrementCounter(stats.fallbackReasons, trace.fallbackReason || trace.reason);
      if (trace.coverageStatus === 'covered_spot' || solverTrace?.classification === 'cold_load') {
        stats.coveredFallbacks += 1;
      }
      if (solverTrace?.reason) incrementCounter(stats.solverReasons, solverTrace.reason);
      if (solverTrace?.classification) {
        incrementCounter(stats.solverClassifications, solverTrace.classification);
      }
      if (solverTrace?.lookupSource) incrementCounter(stats.lookupSources, solverTrace.lookupSource);
    }

    if (typeof trace.latencyMs === 'number' && Number.isFinite(trace.latencyMs)) {
      stats.latencyMsTotal += trace.latencyMs;
      stats.latencySamples += 1;
    }

    const shouldLogSummary =
      stats.decisions === 1 ||
      stats.decisions % RUNTIME_ROLLOUT_LOG_EVERY === 0 ||
      (trace.status === 'fallback' &&
        (trace.coverageStatus === 'covered_spot' || solverTrace?.classification === 'cold_load'));
    if (!shouldLogSummary) return;

    const averageLatencyMs =
      stats.latencySamples > 0
        ? Math.round((stats.latencyMsTotal / stats.latencySamples) * 100) / 100
        : 0;
    this._logEvent(
      'runtime_rollout_summary',
      {
        decisions: stats.decisions,
        solverHits: stats.solverHits,
        pokerSkillHits: stats.pokerSkillHits,
        modelHits: stats.modelHits,
        fallbacks: stats.fallbacks,
        coveredFallbacks: stats.coveredFallbacks,
        lookupSources: stats.lookupSources,
        fallbackReasons: stats.fallbackReasons,
        solverReasons: stats.solverReasons,
        solverClassifications: stats.solverClassifications,
        solverTakeoverModes: stats.solverTakeoverModes,
        averageLatencyMs,
        latestStatus: trace.status,
        latestReason: trace.reason || null,
      },
      trace.status === 'fallback' && stats.coveredFallbacks > 0 ? 'warn' : 'info',
      'Runtime-first rollout summary'
    );
  }

  addPlayer(playerData) {
    if (this.players.length >= this.maxPlayers) return null;
    const player = {
      id: playerData.id,
      name: playerData.name,
      chips: this.startChips,
      holeCards: [],
      bet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      isNPC: playerData.isNPC || false,
      npcProfile: playerData.npcProfile || null,
      seatIndex: this.players.length,
      isConnected: true,
      isReady: false,
      autoPlay: false,
      wins: 0,
      handsPlayed: 0,
    };
    if (!this.isRunning && this.roundCount === 0 && this.players.length > 0) {
      const insertAt = random.randomInt(this.players.length + 1);
      this.players.splice(insertAt, 0, player);
      this.players.forEach((p, i) => (p.seatIndex = i));
    } else {
      this.players.push(player);
    }
    this._log(`📥 seated ${player.name} (${player.isNPC ? 'NPC' : 'human'}) chips:${player.chips}`);
    this._logEvent(
      'player_joined',
      {
        playerId: player.id,
        playerName: this.getPublicName(player),
        isNPC: player.isNPC,
        seatIndex: player.seatIndex,
        chips: player.chips,
      },
      'info',
      'Player joined room'
    );
    return player;
  }

  removePlayer(playerId) {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return;
    const removed = this.players[idx];
    this._log(
      `📤 left ${removed.name} (${removed.isNPC ? 'NPC' : 'human'}) chips:${removed.chips}`
    );
    this.players.splice(idx, 1);
    // Adjust dealerIndex if removed player was before or at dealer position
    if (this.players.length > 0) {
      if (idx < this.dealerIndex) {
        this.dealerIndex--;
      } else if (idx === this.dealerIndex) {
        // Dealer was removed; dealerIndex now points to next player automatically
        // but clamp to valid range
        this.dealerIndex = this.dealerIndex % this.players.length;
      }
      if (this.dealerIndex >= this.players.length) {
        this.dealerIndex = 0;
      }
    } else {
      this.dealerIndex = 0;
    }
    this.players.forEach((p, i) => (p.seatIndex = i));
    this._logEvent(
      'player_left',
      {
        playerId: removed.id,
        playerName: this.getPublicName(removed),
        isNPC: removed.isNPC,
        chips: removed.chips,
      },
      'info',
      'Player left room'
    );
  }

  addNPCs(count) {
    const npcs = getAvailableNPCs(count);
    const added = [];
    for (const npc of npcs) {
      if (this.players.length >= this.maxPlayers) break;
      const player = this.addPlayer({
        id: random.randomId('npc_'),
        name: npc.name,
        isNPC: true,
        npcProfile: npc,
      });
      if (player) added.push(player);
    }
    return added;
  }

  getActivePlayers() {
    return this.players.filter((p) => !p.folded && p.chips > 0);
  }

  getPlayersInHand() {
    return this.players.filter((p) => !p.folded && (p.chips > 0 || p.allIn));
  }

  isSpectatorPlayer(player) {
    return !!(player && !player.isNPC && player.folded && (!player.holeCards || player.holeCards.length === 0));
  }

  clearActionTimeout() {
    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }
    this.turnExpiresAt = null;
    this.turnDurationMs = 0;
  }

  getHumanActionTimeoutMs() {
    if (this.configuredActionTimeoutMs > 0) return this.configuredActionTimeoutMs;
    if (this.gameMode === 'practice') return PRACTICE_ACTION_TIMEOUT_MS;
    if (this.gameMode === 'tournament') return TOURNAMENT_ACTION_TIMEOUT_MS;
    return CASH_IDLE_TIMEOUT_MS;
  }

  scheduleActionTimeout() {
    this.clearActionTimeout();
    if (!this.isRunning || this.isPaused) return;
    const current = this.players[this.currentPlayerIndex];
    if (
      !current ||
      current.folded ||
      current.allIn ||
      this.isAutomatedPlayer(current) ||
      current.isNPC
    ) {
      return;
    }

    const timeoutMs = this.getHumanActionTimeoutMs();
    this.actionTimeoutMs = timeoutMs;
    this.turnDurationMs = timeoutMs;
    this.turnExpiresAt = Date.now() + timeoutMs;
    this.actionTimeout = setTimeout(() => {
      if (!this.isRunning || this.isPaused) return;
      const liveCurrent = this.players[this.currentPlayerIndex];
      if (
        !liveCurrent ||
        liveCurrent.id !== current.id ||
        liveCurrent.folded ||
        liveCurrent.allIn ||
        this.isAutomatedPlayer(liveCurrent)
      ) {
        return;
      }
      liveCurrent.autoPlay = true;
      this.emitMessage(`${this.getPublicName(liveCurrent)} timed out and switched to auto-play`);
      this._log(`⏱ ${this.getPublicName(liveCurrent)} timed out -> auto-play`);
      this.emitUpdate();
      this.processNPCTurn();
    }, timeoutMs);
    if (this.actionTimeout.unref) this.actionTimeout.unref();
  }

  beginCurrentTurn() {
    const current = this.players[this.currentPlayerIndex];
    if (!current || !this.isRunning) {
      this.clearActionTimeout();
      this.emitUpdate();
      return;
    }
    if (this.isAutomatedPlayer(current)) {
      this.clearActionTimeout();
      this.emitUpdate();
      this.processNPCTurn();
      return;
    }
    this.scheduleActionTimeout();
    this.emitUpdate();
  }

  startRound() {
    const startedAt = Number(process.hrtime.bigint()) / 1e6;
    if (this.players.length < 2) return false;
    this.gameOver = null;
    this.clearActionTimeout();

    // Remove busted players (keep NPCs by refilling them optionally)
    this.players = this.players.filter((p) => p.chips > 0 || !p.isNPC);

    if (this.players.filter((p) => p.chips > 0).length < 2) return false;

    this.roundCount++;

    // Tick equity unused counter (5 consecutive unused = price drop)
    this.tickEquityStreak();
    for (const p of this.players) {
      this.initEquityState(p.id);
    }

    this.deck = shuffle(createDeck());
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.currentBet = 0;
    // Tournament: update blinds from current level
    if (this.tournament && this.tournament.isActive) {
      const blinds = this.tournament.getCurrentBlinds();
      this.smallBlind = blinds.sb;
      this.bigBlind = blinds.bb;
    }
    this.minRaise = this.bigBlind;
    this.roundBets = {};
    this.raiseCount = 0; // Raise cap: max 4 raises per betting round
    this.equitySnapshots = {};

    // v4: Initialize hand tracking for opponent modeling
    this.handActionHistory = {};
    this.handActionLog = [];
    this.handStartPlayerCount = 0;
    this.handStartStacks = {};
    this.preflopRaiserId = null;
    this.lastRoundWinnerIds = [];
    this.lastRoundRefunds = [];

    // Reset player states
    for (const p of this.players) {
      p.holeCards = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = p.chips <= 0;
      p.allIn = false;
      p.lastAction = null;
      p.handsPlayed++;
    }

    // Move dealer
    this.dealerIndex = this.dealerIndex % this.players.length;
    while (this.players[this.dealerIndex].chips <= 0) {
      this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    }

    // Post blinds — heads-up special rule: dealer posts SB
    const activePlayers = this.players.filter((p) => p.chips > 0);
    this.handStartPlayerCount = activePlayers.length;
    this.handStartStacks = Object.fromEntries(activePlayers.map((player) => [player.id, player.chips]));
    let sbIdx, bbIdx;
    if (activePlayers.length === 2) {
      // Heads-up: dealer IS the small blind
      sbIdx = this.dealerIndex;
      bbIdx = this.getNextActiveIndex(this.dealerIndex);
    } else {
      // 3+ players: standard order
      sbIdx = this.getNextActiveIndex(this.dealerIndex);
      bbIdx = this.getNextActiveIndex(sbIdx);
    }
    this.sbIndex = sbIdx;
    this.bbIndex = bbIdx;
    this.postBlind(sbIdx, this.smallBlind);
    this.postBlind(bbIdx, this.bigBlind);
    this.currentBet = this.bigBlind;

    // Deal hole cards
    for (const p of this.players) {
      if (!p.folded) {
        p.holeCards = [this.deck.pop(), this.deck.pop()];
      }
    }

    this.phase = 'preflop';
    // Heads-up preflop: SB (dealer) acts first
    if (activePlayers.length === 2) {
      this.currentPlayerIndex = sbIdx;
    } else {
      this.currentPlayerIndex = this.getNextActiveIndex(bbIdx);
    }
    this.lastRaiserIndex = bbIdx;
    this.isRunning = true;

    // Start tracking this hand
    const activeIds = this.players.filter((p) => !p.folded).map((p) => p.id);
    this.playerStats.newHand(activeIds);
    for (const id of activeIds) {
      this.handActionHistory[id] = [];
    }

    // Hand history recording
    this.handHistory.startHand(
      this.roundCount,
      this.players.filter((p) => !p.folded),
      this.dealerIndex,
      sbIdx,
      bbIdx,
      { sb: this.smallBlind, bb: this.bigBlind }
    );

    const dealer = this.players[this.dealerIndex];
    const sbPlayer = this.players[sbIdx];
    const bbPlayer = this.players[bbIdx];
    this.emitMessage(
      `🃏 Hand ${this.roundCount} starts! Dealer: ${this.players[this.dealerIndex].name}` +
        (this.tournament && this.tournament.isActive
          ? ` | blinds ${this.smallBlind}/${this.bigBlind}`
          : '')
    );
    this._logEvent(
      'round_start',
      {
        durationMs: Math.round((Number(process.hrtime.bigint()) / 1e6 - startedAt) * 100) / 100,
        dealer: this.getPublicName(dealer),
        smallBlindPlayer: this.getPublicName(sbPlayer),
        bigBlindPlayer: this.getPublicName(bbPlayer),
        smallBlind: this.smallBlind,
        bigBlind: this.bigBlind,
        playerOrder: this.players.map((player) => ({
          id: player.id,
          name: this.getPublicName(player),
          seatIndex: player.seatIndex,
          chips: player.chips,
          isNPC: player.isNPC,
        })),
      },
      'info',
      'Round started'
    );

    // v10: round start log
    const npcNames = this.players
      .filter((p) => p.isNPC)
      .map((p) => p.name)
      .join(', ');
    this._log(`Hand ${this.roundCount} start | NPC: ${npcNames}`);

    // Log deal: dealer, blinds, hole cards
    this._log(
      `🎰 D:${dealer.name} SB:${sbPlayer.name}(${this.smallBlind}) BB:${bbPlayer.name}(${this.bigBlind})`
    );
    for (const p of this.players) {
      if (!p.folded && p.holeCards.length === 2) {
        if (p.isNPC) {
          this._log(`🃏 ${p.name}: ${this._cards(p.holeCards)}`);
        } else {
          this._log(`🃏 ${p.name}: [hidden]`);
        }
      }
    }

    // Reset auto-equity tracker (-1 ensures preflop push)
    this._lastAutoEqCCLen = -1;

    this.beginCurrentTurn();

    return true;
  }

  postBlind(playerIdx, amount) {
    const player = this.players[playerIdx];
    const actual = Math.min(amount, player.chips);
    player.chips -= actual;
    player.bet = actual;
    player.totalBet = actual;
    this.pot += actual;
    if (player.chips === 0) player.allIn = true;
  }

  getNextActiveIndex(fromIndex) {
    let idx = (fromIndex + 1) % this.players.length;
    let safety = 0;
    while (
      (this.players[idx].folded || this.players[idx].allIn || this.players[idx].chips <= 0) &&
      safety < this.players.length
    ) {
      idx = (idx + 1) % this.players.length;
      safety++;
    }
    // If safety exhausted (all players folded/allIn), return fromIndex+1 clamped
    // This prevents infinite loops and lets advanceAction handle the end-of-round
    if (safety >= this.players.length) {
      return (fromIndex + 1) % this.players.length;
    }
    return idx;
  }

  handleAction(playerId, action, amount = 0) {
    const playerIdx = this.players.findIndex((p) => p.id === playerId);
    if (playerIdx === -1 || playerIdx !== this.currentPlayerIndex) return false;
    const player = this.players[playerIdx];
    if (player.folded || player.allIn) return false;

    const toCall = this.currentBet - player.bet;
    const potBeforeAction = this.pot;
    const currentBetBeforeAction = this.currentBet;
    const playerBetBeforeAction = player.bet;
    const chipsBeforeAction = player.chips;

    // ── FIX: Action Validation ──
    // If all other non-folded players are all-in, you can only call or fold.
    // Raising has no meaning because nobody can respond.
    const othersCanAct = this.players.filter(
      (p) => p.id !== playerId && !p.folded && !p.allIn && p.chips > 0
    );
    if (othersCanAct.length === 0 && (action === 'raise' || action === 'allin')) {
      // Force to call (or fold if they choose)
      action = toCall > 0 ? 'call' : 'check';
    }

    let recordedAmount = 0;

    switch (action) {
      case 'fold':
        player.folded = true;
        this.emitMessage(`${this.getPublicName(player)} folds`);
        recordedAmount = 0;
        break;

      case 'check':
        if (toCall > 0) return false;
        this.emitMessage(`${this.getPublicName(player)} checks`);
        recordedAmount = 0;
        break;

      case 'call':
        if (toCall <= 0) {
          this.emitMessage(`${this.getPublicName(player)} checks`);
          recordedAmount = 0;
          action = 'check';
          break;
        }
        const callAmount = Math.min(toCall, player.chips);
        player.chips -= callAmount;
        player.bet += callAmount;
        player.totalBet += callAmount;
        this.pot += callAmount;
        if (player.chips === 0) player.allIn = true;
        this.emitMessage(`${this.getPublicName(player)} calls ${callAmount}`);
        recordedAmount = callAmount;
        break;

      case 'raise':
        // Enforce raise cap (max 4 raises per betting round)
        if (this.raiseCount >= 4) {
          // Cap reached, convert to call
          const capCall = Math.min(this.currentBet - player.bet, player.chips);
          if (capCall > 0) {
            player.chips -= capCall;
            player.bet += capCall;
            player.totalBet += capCall;
            this.pot += capCall;
            if (player.chips === 0) player.allIn = true;
          }
          this.emitMessage(`${this.getPublicName(player)} calls ${capCall} (raise cap)`);
          recordedAmount = capCall;
          action = 'call';
          break;
        }
        const minRaiseTotal = this.currentBet + this.minRaise;
        const maxReachableTotal = player.bet + player.chips;
        if (maxReachableTotal <= this.currentBet) {
          const forcedCall = Math.min(toCall, player.chips);
          player.chips -= forcedCall;
          player.bet += forcedCall;
          player.totalBet += forcedCall;
          this.pot += forcedCall;
          if (player.chips === 0) player.allIn = true;
          this.emitMessage(`${this.getPublicName(player)} calls ${forcedCall}`);
          recordedAmount = forcedCall;
          action = forcedCall > 0 ? 'call' : 'check';
          break;
        }
        if (maxReachableTotal < minRaiseTotal) {
          const shortAllInAmount = player.chips;
          player.bet += shortAllInAmount;
          player.totalBet += shortAllInAmount;
          this.pot += shortAllInAmount;
          player.chips = 0;
          player.allIn = true;
          if (player.bet > this.currentBet) {
            const raiseIncrement = player.bet - this.currentBet;
            const isFullRaise = raiseIncrement >= this.minRaise;
            this.currentBet = player.bet;
            if (isFullRaise) {
              this.lastRaiserIndex = playerIdx;
              this.minRaise = Math.max(this.bigBlind, raiseIncrement);
            }
          }
          this.emitMessage(`${this.getPublicName(player)} all-in ${shortAllInAmount}!`);
          recordedAmount = player.bet;
          action = 'allin';
          break;
        }
        this.raiseCount++;
        const raiseTotal = Math.max(amount, minRaiseTotal);
        const raiseAmount = Math.min(raiseTotal - player.bet, player.chips);
        player.chips -= raiseAmount;
        player.bet += raiseAmount;
        player.totalBet += raiseAmount;
        this.pot += raiseAmount;
        const prevBet = this.currentBet;
        this.currentBet = player.bet;
        this.minRaise = Math.max(this.bigBlind, player.bet - prevBet);
        this.lastRaiserIndex = playerIdx;
        if (player.chips === 0) {
          player.allIn = true;
          this.emitMessage(`${this.getPublicName(player)} all-in ${raiseAmount}!`);
          recordedAmount = player.bet;
        } else {
          this.emitMessage(`${this.getPublicName(player)} raises to ${player.bet}`);
          recordedAmount = player.bet;
        }
        break;

      case 'allin':
        const allInAmount = player.chips;
        player.bet += allInAmount;
        player.totalBet += allInAmount;
        this.pot += allInAmount;
        player.chips = 0;
        player.allIn = true;
        if (player.bet > this.currentBet) {
          const raiseIncrement = player.bet - this.currentBet;
          const isFullRaise = raiseIncrement >= this.minRaise;
          this.currentBet = player.bet;
          if (isFullRaise) {
            // Full raise: reopen action, all players get to act again
            this.lastRaiserIndex = playerIdx;
            this.minRaise = Math.max(this.bigBlind, raiseIncrement);
          }
          // If NOT a full raise: currentBet updates (so others know the call price)
          // but lastRaiserIndex stays unchanged (doesn't reopen action for
          // players who already acted — they only need to match or fold)
        }
        this.emitMessage(`${this.getPublicName(player)} all-in ${allInAmount}!`);
        recordedAmount = player.bet;
        break;

      default:
        return false;
    }

    this.clearActionTimeout();

    // v4: Record action for opponent modeling
    const facingRaise = toCall > 0;
    const isBlind = false; // blinds are posted separately via postBlind()
    this.playerStats.recordAction(playerId, this.phase, action, recordedAmount, {
      facingRaise,
      isBlind,
      firstToAct: this.currentBet === 0,
      checkedTo: this.currentBet === 0,
    });
    if (this.handActionHistory[playerId]) {
      this.handActionHistory[playerId].push({ phase: this.phase, action, amount: recordedAmount });
    }
    this.handActionLog.push({
      phase: this.phase,
      playerId,
      action,
      amount: recordedAmount,
      contribution: Math.max(0, player.bet - playerBetBeforeAction),
      potBeforeAction,
      potAfterAction: this.pot,
      currentBetBeforeAction,
      currentBetAfterAction: this.currentBet,
      playerBetBeforeAction,
      playerBetAfterAction: player.bet,
      toCallBeforeAction: toCall,
      chipsBeforeAction,
      chipsAfterAction: player.chips,
    });

    // v9.5: log human player actions to server
    if (!player.isNPC) {
      const actStr =
        action === 'raise'
          ? `raise ${player.bet}`
          : action === 'allin'
            ? `all_in ${player.bet}`
            : action === 'call'
              ? `call ${recordedAmount}`
              : action;
      this._log(
        `👤 ${player.name}: ${actStr} (chips:${player.chips} invested:${player.totalBet} pot:${this.pot})`
      );
    }
    // Track preflop raiser for c-bet detection
    if (this.phase === 'preflop' && (action === 'raise' || action === 'allin')) {
      this.preflopRaiserId = playerId;
    }

    // Hand history recording
    const p = this.players.find((pp) => pp.id === playerId);
    if (p) p.lastAction = { action, amount: recordedAmount, time: Date.now() };
    this.handHistory.recordAction(
      playerId,
      p ? this.getPublicName(p) : '?',
      this.phase,
      action,
      recordedAmount,
      this.pot
    );
    this._logEvent(
      'player_action',
      {
        playerId,
        playerName: p ? this.getPublicName(p) : playerId,
        action,
        amount: recordedAmount,
        currentBet: this.currentBet,
        playerBet: p ? p.bet : 0,
        playerChips: p ? p.chips : 0,
        toCallAfterAction: p ? Math.max(0, this.currentBet - p.bet) : 0,
      },
      'info',
      'Player action applied'
    );

    // v7: Track recent actions for self-image awareness (keep last 30)
    if (p) {
      if (!p._recentActions) p._recentActions = [];
      p._recentActions.push({ action, phase: this.phase });
      if (p._recentActions.length > 30) p._recentActions.shift();
    }

    // NPC chat: react to own actions
    if (p && p.isNPC) {
      let chatEvent = null;
      if (action === 'fold') chatEvent = 'fold';
      else if (action === 'allin') chatEvent = 'allin';
      if (chatEvent) {
        const msg = generateNPCChat(p.name, chatEvent, 0.35);
        if (msg) {
          const avatar = p.npcProfile?.avatar || '';
          this.emitMessage(`💬 ${avatar} ${this.getPublicName(p)}: ${msg}`);
        }
      }
    }

    this.advanceAction();
    return true;
  }

  advanceAction() {
    // Check if only one player left
    const activePlayers = this.getPlayersInHand();
    if (activePlayers.filter((p) => !p.folded).length === 1) {
      this.awardPot(activePlayers.filter((p) => !p.folded));
      this.endRound();
      return;
    }

    // Find next player who can act
    let nextIdx = (this.currentPlayerIndex + 1) % this.players.length;
    let safety = 0;
    while (safety < this.players.length) {
      const p = this.players[nextIdx];
      if (!p.folded && !p.allIn && p.chips > 0) {
        // Check if betting round is complete
        if (nextIdx === this.lastRaiserIndex) {
          // Edge case: a short all-in after us raised currentBet
          // but didn't reopen action. We still need to match or fold.
          if (p.bet < this.currentBet) {
            break; // Let this player act (fold/call to match)
          }
          this.nextPhase();
          return;
        }
        break;
      }
      nextIdx = (nextIdx + 1) % this.players.length;
      safety++;

      if (nextIdx === this.lastRaiserIndex) {
        // Check if this player still needs to act
        const lp = this.players[nextIdx];
        if (lp.folded || lp.allIn) {
          this.nextPhase();
          return;
        }
        // If their bet < currentBet (short all-in raised the price), they must act
        if (lp.bet >= this.currentBet) {
          this.nextPhase();
          return;
        }
        break;
      }
    }

    // If all remaining players are all-in or folded
    const canAct = this.players.filter((p) => !p.folded && !p.allIn && p.chips > 0);
    if (canAct.length === 0) {
      // Deal remaining community cards
      this.dealRemainingCards();
      return;
    }

    if (canAct.length === 1 && canAct[0].bet >= this.currentBet) {
      // Preflop live blind: BB gets option to raise even if everyone limped/folded
      const isBBLiveBlind =
        this.phase === 'preflop' && canAct[0].seatIndex === this.bbIndex && !canAct[0].lastAction; // BB hasn't acted yet this hand
      if (isBBLiveBlind) {
        this.currentPlayerIndex = canAct[0].seatIndex;
        this.emitUpdate();
        this.processNPCTurn();
        return;
      }
      this.nextPhase();
      return;
    }

    this.currentPlayerIndex = nextIdx;
    this.beginCurrentTurn();
  }

  dealRemainingCards() {
    while (this.communityCards.length < 5) {
      this.deck.pop(); // burn
      this.communityCards.push(this.deck.pop());
    }
    this.phase = 'showdown';
    this.showdown();
  }

  nextPhase() {
    const phaseIdx = PHASES.indexOf(this.phase);
    if (phaseIdx >= 4) {
      this.phase = 'showdown';
      this.showdown();
      return;
    }

    // Reset bets for new betting round
    for (const p of this.players) {
      p.bet = 0;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.raiseCount = 0;

    switch (PHASES[phaseIdx + 1]) {
      case 'flop':
        this.deck.pop(); // burn
        this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        this.phase = 'flop';
        this.emitMessage(`── Flop ──`);
        this._log(`🂠 flop: ${this._cards(this.communityCards)} (pot:${this.pot})`);
        this._logEvent(
          'street_advance',
          { street: 'flop', communityCards: this.communityCards.map((card) => this._card(card)) },
          'info',
          'Street advanced to flop'
        );
        break;
      case 'turn':
        this.deck.pop();
        this.communityCards.push(this.deck.pop());
        this.phase = 'turn';
        this.emitMessage(`── Turn ──`);
        this._log(
          `🂠 turn: ${this._card(this.communityCards[3])} → ${this._cards(this.communityCards)} (pot:${this.pot})`
        );
        this._logEvent(
          'street_advance',
          { street: 'turn', communityCards: this.communityCards.map((card) => this._card(card)) },
          'info',
          'Street advanced to turn'
        );
        break;
      case 'river':
        this.deck.pop();
        this.communityCards.push(this.deck.pop());
        this.phase = 'river';
        this.emitMessage(`── River ──`);
        this._log(
          `🂠 river: ${this._card(this.communityCards[4])} → ${this._cards(this.communityCards)} (pot:${this.pot})`
        );
        this._logEvent(
          'street_advance',
          { street: 'river', communityCards: this.communityCards.map((card) => this._card(card)) },
          'info',
          'Street advanced to river'
        );
        break;
    }

    // Record community cards for replay
    this.handHistory.recordCommunityCards(this.communityCards);

    this.prewarmSolverTreesForStreet();

    // First to act is after dealer
    this.currentPlayerIndex = this.getNextActiveIndex(this.dealerIndex);
    this.lastRaiserIndex = this.currentPlayerIndex;

    // Check if only all-in players remain
    const canAct = this.players.filter((p) => !p.folded && !p.allIn && p.chips > 0);
    if (canAct.length <= 1) {
      if (this.communityCards.length < 5) {
        this.dealRemainingCards();
        return;
      }
      this.phase = 'showdown';
      this.showdown();
      return;
    }

    this.beginCurrentTurn();
  }

  showdown() {
    this.phase = 'showdown';
    const contenders = this.players.filter((p) => !p.folded);

    if (contenders.length === 1) {
      this.awardPot(contenders);
      this.endRound();
      return;
    }

    // Evaluate hands
    const results = contenders.map((p) => {
      const allCards = [...p.holeCards, ...this.communityCards];
      const hand = evaluateHand(allCards);
      return { player: p, hand };
    });

    // Sort by hand strength
    results.sort((a, b) => compareHands(b.hand, a.hand));

    // Announce hands
    for (const r of results) {
      this.emitMessage(`${this.getPublicName(r.player)}: ${r.hand.name}`);
    }

    // Handle side pots and main pot
    this.distributePot(results);

    // NPC reactions to winning/losing
    for (const r of results) {
      if (!r.player.isNPC) continue;
      const won = r._wonContestedPot && r._awarded > 0;
      const msg = generateNPCChat(r.player.name, won ? 'win' : 'lose', won ? 0.6 : 0.3);
      if (msg) {
        const avatar = r.player.npcProfile?.avatar || '';
        this.emitMessage(`💬 ${avatar} ${this.getPublicName(r.player)}: ${msg}`);
      }
    }

    // v4: Record showdown hands for opponent modeling
    const winnerRank = results[0].hand;
    for (const r of results) {
      const won = compareHands(r.hand, winnerRank) >= 0;
      this.playerStats.recordShowdown(r.player.id, r.player.holeCards, won);
    }

    // v8: Update NPC psychology after showdown
    const winnerIds = results
      .filter((r) => compareHands(r.hand, winnerRank) >= 0)
      .map((r) => r.player.id);
    for (const r of results) {
      if (r.player.isNPC) {
        const isWinner = winnerIds.includes(r.player.id);
        this.npcPsychology.updateAfterHand(
          r.player.id,
          {
            won: isWinner,
            lost: !isWinner,
            amount: r._awarded || r.player.totalBet,
            taker: !isWinner ? results[0].player.id : null,
            wasAggressive: (this.handActionHistory[r.player.id] || []).some(
              (a) => a.action === 'raise' || a.action === 'allin'
            ),
            caughtBluffing:
              !isWinner &&
              (this.handActionHistory[r.player.id] || []).some((a) => a.action === 'raise'),
          },
          r.player.npcProfile
        );
      }
    }

    this.endRound();
  }

  distributePot(results) {
    // ── Proper side pot distribution ──
    // 1. Collect all unique totalBet levels from contenders (non-folded)
    // 2. For each level, calculate the pot slice and award to best hand
    // 3. Excess chips (uncontested) get refunded

    const contenders = results.map((r) => r.player);
    const allPlayers = this.players; // includes folded players who contributed

    // Get unique bet levels sorted ascending
    const betLevels = [...new Set(contenders.map((p) => p.totalBet))].sort((a, b) => a - b);

    let previousLevel = 0;
    let totalAwarded = 0;

    for (const level of betLevels) {
      // Calculate this pot slice: each player contributes (level - previousLevel) capped by their totalBet
      let potSlice = 0;
      for (const p of allPlayers) {
        const contribution = Math.min(p.totalBet, level) - Math.min(p.totalBet, previousLevel);
        potSlice += Math.max(0, contribution);
      }

      if (potSlice <= 0) {
        previousLevel = level;
        continue;
      }

      // Who is eligible for this pot slice? Contenders whose totalBet >= level
      const eligible = results.filter((r) => r.player.totalBet >= level);
      if (eligible.length === 0) {
        previousLevel = level;
        continue;
      }

      // Find the best hand(s) among eligible
      eligible.sort((a, b) => compareHands(b.hand, a.hand));
      const bestHand = eligible[0].hand;
      const winners = eligible.filter((r) => compareHands(r.hand, bestHand) === 0);

      // Split pot slice among winners
      const share = Math.floor(potSlice / winners.length);
      let remainder = potSlice - share * winners.length;

      for (const winner of winners) {
        const award = share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
        winner.player.chips += award;
        totalAwarded += award;
        if (!winner._awarded) winner._awarded = 0;
        winner._awarded += award;
        // Track: did this player win a CONTESTED pot (2+ eligible players)?
        // If so, they're a real winner. If they only got money from a level
        // where they were the sole eligible player, it's a refund.
        if (eligible.length >= 2) {
          winner._wonContestedPot = true;
        }
      }

      previousLevel = level;
    }

    // Emit winner messages
    const awardedPlayers = results.filter((r) => r._awarded && r._awarded > 0);
    const isSplitPot =
      awardedPlayers.length > 1 &&
      awardedPlayers.filter((r) => r._wonContestedPot).length > 1 &&
      awardedPlayers
        .filter((r) => r._wonContestedPot)
        .every(
          (r) =>
            compareHands(r.hand, awardedPlayers.filter((x) => x._wonContestedPot)[0].hand) === 0
        );

    for (const r of results) {
      if (r._awarded && r._awarded > 0) {
        if (r._wonContestedPot) {
          // This player won a pot slice where they beat at least one other player
          r.player.wins++;
          this.lastRoundWinnerIds.push(r.player.id);
          if (isSplitPot) {
            this.emitMessage(`🤝 ${this.getPublicName(r.player)} splits pot ${r._awarded} (${r.hand.name})`);
          } else {
            this.emitMessage(`🏆 ${this.getPublicName(r.player)} wins ${r._awarded}! (${r.hand.name})`);
          }
          this._log(
            `💰 ${this.getPublicName(r.player)} wins ${r._awarded} (${r.hand.name}) bal:${r.player.chips}`
          );
          this.handHistory.recordWinner(
            r.player.id,
            this.getPublicName(r.player),
            r._awarded,
            r.hand.name
          );
        } else {
          // Only got money from uncontested levels — refund
          this.lastRoundRefunds.push({
            playerId: r.player.id,
            playerName: this.getPublicName(r.player),
            amount: r._awarded,
            reason: 'unmatched all-in chips',
          });
          this.emitMessage(`↩ ${this.getPublicName(r.player)} unmatched chips returned ${r._awarded}`);
          this._log(`💰 ${this.getPublicName(r.player)} refund ${r._awarded} bal:${r.player.chips}`);
        }
      }
    }

    // Safety check: if any chips were unaccounted for due to rounding,
    // refund to the player with the highest totalBet (ONLY if betLevels didn't already handle it)
    const totalPot = this.pot;
    const unawarded = totalPot - totalAwarded;
    if (unawarded > 0) {
      // Check if any contender already received a refund at their betLevel
      // (sole eligible at top level = already refunded via betLevels loop)
      const topLevel = betLevels[betLevels.length - 1];
      const topEligible = results.filter((r) => r.player.totalBet >= topLevel);
      const alreadyRefunded = topEligible.length === 1 && topEligible[0]._awarded > 0;
      if (!alreadyRefunded) {
        const maxBettor = contenders.reduce((a, b) => (a.totalBet > b.totalBet ? a : b));
        maxBettor.chips += unawarded;
        totalAwarded += unawarded;
        this.lastRoundRefunds.push({
          playerId: maxBettor.id,
          playerName: this.getPublicName(maxBettor),
          amount: unawarded,
          reason: 'unmatched all-in chips',
        });
        this.emitMessage(`↩ ${this.getPublicName(maxBettor)} unmatched chips returned ${unawarded}`);
      }
    }
  }

  awardPot(winners) {
    const share = Math.floor(this.pot / winners.length);
    for (const winner of winners) {
      winner.chips += share;
      winner.wins++;
      this.lastRoundWinnerIds.push(winner.id);
      this.emitMessage(`🏆 ${this.getPublicName(winner)} wins ${share}!`);
      this._log(`💰 ${this.getPublicName(winner)} wins ${share} (all folded) bal:${winner.chips}`);
      this.handHistory.recordWinner(
        winner.id,
        this.getPublicName(winner),
        share,
        'all opponents folded'
      );
    }
  }

  endRound() {
    this.isRunning = false;
    this.clearActionTimeout();
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;

    // Finish hand history and update leaderboard
    this.handHistory.recordCommunityCards(this.communityCards);
    const finishedHand = this.handHistory.finishHand(this.pot, this.phase);
    if (finishedHand) {
      this.leaderboard.update(finishedHand);
      this.lastWarReport = HandHistory.generateWarReport(finishedHand);
    }

    // Handle busted players
    const bustedPlayers = this.players.filter((p) => p.chips <= 0);
    for (const p of bustedPlayers) {
      this.emitMessage(`${this.getPublicName(p)} eliminated`);
      this._log(`❌ eliminated ${this.getPublicName(p)}`);
      if (this.tournament && this.tournament.isActive) {
        const place = this.tournament.recordElimination(this.getPublicName(p), this.roundCount);
        this.emitMessage(`📊 ${this.getPublicName(p)} placed #${place}`);
      }
    }

    // v9: print chip standings after each round
    const standings = this.players
      .filter((p) => p.chips > 0)
      .sort((a, b) => b.chips - a.chips)
      .map((p) => `${p.name}:${p.chips}`)
      .join(' | ');
    this._log(`📊 Hand ${this.roundCount} end pot:${this.pot} standings: ${standings}`);

    // Tournament: check if tournament is over
    let tournamentResult = null;
    if (this.tournament && this.tournament.isActive) {
      tournamentResult = this.tournament.checkTournamentEnd(this.players);
      if (tournamentResult) {
        this.emitMessage('🏆 Tournament over!');
      }
      this.gameOver = null;
    } else {
      const survivors = this.players.filter((p) => p.chips > 0);
      if (survivors.length < 2) {
        const winner = survivors[0] || null;
        this.gameOver = {
          reason: 'last-player-standing',
          winnerId: winner ? winner.id : null,
          winnerName: winner ? this.getPublicName(winner) : null,
          remainingPlayers: survivors.length,
        };
        if (winner) {
          this.emitMessage(`🏁 ${this.getPublicName(winner)} wins the table`);
        } else {
          this.emitMessage('🏁 Table finished');
        }
      } else {
        this.gameOver = null;
      }
    }

    this._logEvent(
      'round_end',
      {
        finalPhase: this.phase,
        communityCards: this.communityCards.map((card) => this._card(card)),
        winners: this.lastRoundWinnerIds.map((winnerId) => {
          const player = this.players.find((entry) => entry.id === winnerId);
          return {
            id: winnerId,
            name: player ? this.getPublicName(player) : winnerId,
            chips: player ? player.chips : null,
          };
        }),
        refunds: this.lastRoundRefunds,
        players: this.players.map((player) => ({
          id: player.id,
          name: this.getPublicName(player),
          chips: player.chips,
          folded: player.folded,
          allIn: player.allIn,
          isNPC: player.isNPC,
        })),
        gameOver: this.gameOver,
        tournamentActive: !!(this.tournament && this.tournament.isActive),
      },
      'info',
      'Round ended'
    );

    this.emitUpdate();

    // Auto-advance: notify server to schedule next round
    if (this.onRoundEnd) this.onRoundEnd(this, tournamentResult);
  }

  // Stop game engine, cancel all pending NPC timers
  stop() {
    this.isRunning = false;
    this.clearActionTimeout();
    if (this._npcTimer) {
      clearTimeout(this._npcTimer);
      this._npcTimer = null;
    }
    this._log('🛑 Game engine stopped');
  }

  // Pause / Resume
  pause() {
    if (this.isPaused) return;
    this.isPaused = true;
    this.clearActionTimeout();
    if (this._npcTimer) {
      clearTimeout(this._npcTimer);
      this._npcTimer = null;
      this._pausedNpcPending = true;
    }
    this._log('⏸ Game paused');
    this.emitUpdate();
  }

  resume() {
    if (!this.isPaused) return;
    this.isPaused = false;
    this._log('▶ Game resumed');
    if (this._pausedNpcPending) this._pausedNpcPending = false;
    if (this.isRunning) this.beginCurrentTurn();
    else this.emitUpdate();
  }

  // Speed control
  setSpeed(multiplier) {
    this.speedMultiplier = Math.max(1, Math.min(3, multiplier));
    this._log(`⚡ Speed set to ${this.speedMultiplier}x`);
  }

  // Calculate equity (range-weighted MC + hand diagnostics)
  calculateEquity(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player || !player.holeCards || player.holeCards.length < 2) return null;
    if (!this.isRunning || this.phase === 'waiting' || this.phase === 'showdown') return null;
    const opponents = this.players.filter((p) => !p.folded && p.id !== playerId);
    if (opponents.length < 1) return null;

    // Build estimated range for each opponent (observable behavior only)
    const excludeCards = [...player.holeCards, ...this.communityCards];
    const opRanges = [];
    let useRange = false;

    for (const opp of opponents) {
      const actions = this.handActionHistory[opp.id] || [];
      const profile = this.playerStats.getProfile(opp.id);
      if (actions.length > 0) {
        try {
          const range = estimateRange(excludeCards, profile, actions, this.communityCards, {
            bigBlind: this.bigBlind,
            pot: this.pot,
          });
          if (range && range.length > 0) {
            opRanges.push(range);
            useRange = true;
            continue;
          }
        } catch (e) {
          this._log(`⚠️ Range estimation error for ${opp.name}: ${e.message}`, 'warn');
        }
      }
      // No action history or empty range or error → full range (fallback)
      opRanges.push(null);
    }

    // Equity calculation
    let eqResult;
    if (useRange) {
      // Build effective range array (replace null with full range placeholder)
      const validRanges = opRanges
        .map((r) => {
          if (r) return r;
          try {
            return estimateRange(excludeCards, null, [], this.communityCards, {
              bigBlind: this.bigBlind,
              pot: this.pot,
            });
          } catch (e) {
            return null;
          }
        })
        .filter((r) => r && r.length > 0);

      if (validRanges.length > 0) {
        eqResult = rangeWeightedMC(player.holeCards, this.communityCards, validRanges, EQUITY_SIMS);
      } else {
        eqResult = vanillaMC(player.holeCards, this.communityCards, opponents.length, EQUITY_SIMS);
      }
    } else {
      eqResult = vanillaMC(player.holeCards, this.communityCards, opponents.length, EQUITY_SIMS);
    }

    const equityPct = Math.round(eqResult.equity * 1000) / 10;

    // Hand classification (distinguish player-made vs board-only)
    let handName = '';
    let handRank = 0;
    if (this.communityCards.length >= 3) {
      const best = evaluateHand([...player.holeCards, ...this.communityCards]);
      if (best) {
        handRank = best.rank;
        const holeVals = player.holeCards.map((c) => c.value);
        const holeSuits = player.holeCards.map((c) => c.suit);
        let contributed = false;

        if (this.communityCards.length >= 5) {
          // River: compare with/without hole cards directly
          const commBest = evaluateHand(this.communityCards);
          contributed =
            !commBest ||
            best.rank > commBest.rank ||
            (best.rank === commBest.rank && compareHands(best, commBest) > 0);
        } else {
          // Flop/Turn: check if hole cards contribute to made hand
          const commVals = this.communityCards.map((c) => c.value);
          if (best.rank === 2) {
            // One pair: does pair value include a hole card value
            const allVals = [...holeVals, ...commVals];
            const counts = {};
            for (const v of allVals) counts[v] = (counts[v] || 0) + 1;
            const pairVal = Object.entries(counts).find(([, c]) => c >= 2);
            contributed = pairVal && holeVals.includes(parseInt(pairVal[0]));
          } else if (best.rank === 3) {
            // Two pair: at least one pair includes hole card
            const allVals = [...holeVals, ...commVals];
            const counts = {};
            for (const v of allVals) counts[v] = (counts[v] || 0) + 1;
            const pairVals = Object.entries(counts)
              .filter(([, c]) => c >= 2)
              .map(([v]) => parseInt(v));
            contributed = pairVals.some((pv) => holeVals.includes(pv));
          } else if (best.rank === 4) {
            // Three of a kind: does trips value include hole card
            const allVals = [...holeVals, ...commVals];
            const counts = {};
            for (const v of allVals) counts[v] = (counts[v] || 0) + 1;
            const tripVal = Object.entries(counts).find(([, c]) => c >= 3);
            contributed = tripVal && holeVals.includes(parseInt(tripVal[0]));
          } else if (best.rank >= 5) {
            // Straight+: almost always needs hole cards (3-4 community cards alone insufficient)
            contributed = true;
          } else {
            contributed = true; // high card
          }
        }

        if (contributed) {
          handName = HAND_NAMES[best.rank] || '';
        } else if (best.rank >= 2) {
          // Hand made entirely by community cards — lower display weight
          handName = 'board ' + (HAND_NAMES[best.rank] || '');
          handRank = 1; // treat as high card label, avoid misleading board pair
        }
      }
    }

    // Outs calculation
    const outs = this._countOuts(player.holeCards, this.communityCards);

    // Hand strength label
    const label = this._getHandLabel(equityPct, handRank, outs);

    // Delta vs previous equity
    const prevEq = this._lastEquity && this._lastEquity[playerId];
    const delta = prevEq !== undefined ? Math.round((equityPct - prevEq) * 10) / 10 : null;
    if (!this._lastEquity) this._lastEquity = {};
    this._lastEquity[playerId] = equityPct;

    return {
      equity: equityPct, // 47.3
      label, // e.g. "marginal"
      handName, // e.g. "one pair" / "" (preflop)
      outs: outs.total, // 9
      outsDesc: outs.desc, // e.g. "9 outs → flush"
      delta, // -12.5 or null
      rangeAdjusted: useRange, // whether range-weighted was used
    };
  }

  // Outs calculation: detect flush draws, straight draws, etc.
  _countOuts(holeCards, communityCards) {
    if (communityCards.length < 3 || communityCards.length >= 5) {
      return { total: 0, desc: '' };
    }

    const allCards = [...holeCards, ...communityCards];
    const knownSet = new Set(allCards.map((c) => c.rank + c.suit));
    const remainDeck = createDeck().filter((c) => !knownSet.has(c.rank + c.suit));

    // Flush draw detection
    const suitCounts = {};
    for (const c of allCards) {
      suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
    }
    let flushOuts = 0;
    let flushSuit = null;
    for (const [suit, cnt] of Object.entries(suitCounts)) {
      if (cnt === 4) {
        flushSuit = suit;
        flushOuts = remainDeck.filter((c) => c.suit === suit).length;
      }
    }

    // Straight draw detection — collect unique missing values to avoid double-counting
    const vals = [...new Set(allCards.map((c) => c.value))].sort((a, b) => a - b);
    // Ace can also be 1
    if (vals.includes(14)) vals.unshift(1);
    const straightMissing = new Set();
    // Check if 1 card short of straight (open-ended or gutshot)
    for (let target = 5; target <= 14; target++) {
      const needed = [target, target - 1, target - 2, target - 3, target - 4];
      const have = needed.filter((v) => vals.includes(v));
      const missing = needed.filter((v) => !vals.includes(v));
      if (have.length === 4 && missing.length === 1) {
        const missVal = missing[0] === 1 ? 14 : missing[0]; // 1→Ace
        straightMissing.add(missVal);
      }
    }
    let straightOuts = 0;
    for (const mv of straightMissing) {
      straightOuts += remainDeck.filter((c) => c.value === mv).length;
    }
    let straightType = '';
    if (straightMissing.size >= 2) straightType = 'OESD';
    else if (straightMissing.size === 1) straightType = 'gutshot';

    // Pick best draw description
    const draws = [];
    if (flushOuts > 0) draws.push({ outs: flushOuts, desc: `flush draw(${flushOuts})` });
    if (straightOuts > 0)
      draws.push({ outs: straightOuts, desc: `${straightType}(${straightOuts})` });

    // Straight flush draw!
    if (flushOuts > 0 && straightOuts > 0) {
      const combo = flushOuts + straightOuts - 2; // deduplicate (~2 overlap)
      return { total: combo, desc: `flush+${straightType}(~${combo})` };
    }
    if (draws.length > 0) {
      draws.sort((a, b) => b.outs - a.outs);
      return { total: draws[0].outs, desc: draws[0].desc };
    }

    return { total: 0, desc: '' };
  }

  // Hand strength label (equity + made hand + draws)
  _getHandLabel(equity, handRank, outs) {
    // Very high equity = monster (regardless of hand rank)
    if (equity >= 85) return 'monster';
    // Already made a strong hand
    if (handRank >= 7) return 'monster'; // full house+
    if (equity >= 70) return 'strong';
    if (handRank >= 5) return 'strong'; // straight/flush
    if (handRank >= 4) return 'decent'; // three of a kind

    // Many outs (drawing state)
    if (outs.total >= 8) return 'strong draw'; // flush draw / open-ended straight draw
    if (outs.total >= 4) return 'drawing'; // gutshot etc.

    // Judge by equity
    if (equity >= 50) return 'decent';
    if (equity >= 35) return 'marginal';
    if (equity >= 20) return 'weak';
    return 'danger';
  }

  // v11: Equity usage & billing (cash/tournament only)
  initEquityState(playerId) {
    if (!this.equityState[playerId]) {
      this.equityState[playerId] = { freeLeft: 3, priceLevel: 0, unusedStreak: 0 };
    }
  }

  _getEquitySnapshotKey(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player || !player.holeCards || player.holeCards.length < 2) return null;
    return JSON.stringify({
      roundCount: this.roundCount,
      board: this.communityCards.map((c) => `${c.rank}${c.suit}`),
      hero: player.holeCards.map((c) => `${c.rank}${c.suit}`),
    });
  }

  useEquity(playerId) {
    try {
      this.initEquityState(playerId);
      const es = this.equityState[playerId];
      const player = this.players.find((p) => p.id === playerId);
      if (!player) {
        this._logEvent(
          'equity_rejected',
          { playerId, reason: 'player_not_found' },
          'warn',
          'Equity request rejected'
        );
        return { error: 'Player not found' };
      }
      if (this.communityCards.length < 3) {
        this._logEvent(
          'equity_rejected',
          { playerId, playerName: this.getPublicName(player), reason: 'preflop_locked' },
          'info',
          'Equity request rejected'
        );
        return { error: 'Equity oracle opens on the flop' };
      }

      const snapshotKey = this._getEquitySnapshotKey(playerId);
      const cachedSnapshot = snapshotKey ? this.equitySnapshots[playerId] : null;
      if (cachedSnapshot && cachedSnapshot.key === snapshotKey) {
        const nextPrice =
          this.gameMode === 'practice' ? 0 : this._equityPrice((this.equityState[playerId] || {}).priceLevel || 0);
        this._logEvent(
          'equity_reused',
          {
            playerId,
            playerName: this.getPublicName(player),
            mode: this.gameMode,
            freeLeft: this.gameMode === 'practice' ? Infinity : es.freeLeft,
            priceLevel: this.gameMode === 'practice' ? 0 : es.priceLevel,
            nextPrice,
          },
          'info',
          'Equity result reused for unchanged board state'
        );
        return {
          ...cachedSnapshot.result,
          unchanged: true,
          cost: 0,
          freeLeft: this.gameMode === 'practice' ? Infinity : es.freeLeft,
          priceLevel: this.gameMode === 'practice' ? 0 : es.priceLevel,
          nextPrice,
        };
      }

      const result = this.calculateEquity(playerId);
      if (result === null) {
        this._logEvent(
          'equity_rejected',
          { playerId, playerName: this.getPublicName(player), reason: 'calculation_unavailable' },
          'warn',
          'Equity request rejected'
        );
        return { error: 'Equity unavailable right now' };
      }

      if (this.gameMode === 'practice') {
        if (snapshotKey) {
          this.equitySnapshots[playerId] = { key: snapshotKey, result };
        }
        this._logEvent(
          'equity_used',
          {
            playerId,
            playerName: this.getPublicName(player),
            mode: this.gameMode,
            cost: 0,
            freeLeft: Infinity,
            priceLevel: 0,
          },
          'info',
          'Equity used'
        );
        return { ...result, cost: 0, freeLeft: Infinity, nextPrice: 0, priceLevel: 0 };
      }

      if (es.freeLeft > 0) {
        es.freeLeft--;
        es.unusedStreak = 0;
        if (snapshotKey) {
          this.equitySnapshots[playerId] = { key: snapshotKey, result };
        }
        this._logEvent(
          'equity_used',
          {
            playerId,
            playerName: this.getPublicName(player),
            mode: this.gameMode,
            cost: 0,
            freeLeft: es.freeLeft,
            priceLevel: es.priceLevel,
          },
          'info',
          'Equity used'
        );
        return {
          ...result,
          cost: 0,
          freeLeft: es.freeLeft,
          priceLevel: es.priceLevel,
          nextPrice: this._equityPrice(es.priceLevel),
        };
      }

      const price = this._equityPrice(es.priceLevel);
      if (!Number.isFinite(price) || price <= 0) {
        this._logEvent(
          'equity_rejected',
          { playerId, playerName: this.getPublicName(player), reason: 'invalid_price', price },
          'warn',
          'Equity request rejected'
        );
        return { error: 'Equity unavailable right now' };
      }
      if (!Number.isFinite(player.chips) || player.chips <= 0 || price > player.chips) {
        this._logEvent(
          'equity_rejected',
          {
            playerId,
            playerName: this.getPublicName(player),
            reason: 'insufficient_chips',
            price,
            chips: player.chips,
          },
          'info',
          'Equity request rejected'
        );
        return { error: 'Not enough chips', price };
      }

      player.chips -= price;
      es.priceLevel++;
      es.unusedStreak = 0;
      if (snapshotKey) {
        this.equitySnapshots[playerId] = { key: snapshotKey, result };
      }
      this._log(`🔮 ${player.name} used equity oracle, cost ${price} chips`);
      this._logEvent(
        'equity_used',
        {
          playerId,
          playerName: this.getPublicName(player),
          mode: this.gameMode,
          cost: price,
          freeLeft: 0,
          priceLevel: es.priceLevel,
          nextPrice: this._equityPrice(es.priceLevel),
          chipsAfter: player.chips,
        },
        'info',
        'Equity used'
      );
      return {
        ...result,
        cost: price,
        freeLeft: 0,
        priceLevel: es.priceLevel,
        nextPrice: this._equityPrice(es.priceLevel),
      };
    } catch (e) {
      this._log(`⚠️ Equity calculation error: ${e.message}`);
      this._logEvent(
        'equity_rejected',
        { playerId, reason: 'exception', error: e.message },
        'error',
        'Equity request failed'
      );
      return { error: 'Calculation error' };
    }
  }

  // Per-round: consecutive unused ticks = price drop
  tickEquityStreak() {
    for (const pid of Object.keys(this.equityState)) {
      const es = this.equityState[pid];
      es.unusedStreak++;
      if (es.unusedStreak >= 5 && es.priceLevel > 0) {
        es.priceLevel--;
        es.unusedStreak = 0;
      }
    }
  }

  _equityPrice(level) {
    return this.bigBlind * Math.pow(2, level); // 1BB, 2BB, 4BB, 8BB, 16BB...
  }

  isAutomatedPlayer(player) {
    return !!(player && (player.isNPC || player.autoPlay));
  }

  getPublicName(player) {
    if (!player) return '';
    if (player.isNPC && player.npcProfile && player.npcProfile.isWestern) {
      return player.npcProfile.nameEn || player.name;
    }
    return player.name;
  }

  getAutoPlayProfile(player) {
    const seedSource = String(player?.id || player?.name || 'auto');
    const seed =
      [...seedSource].reduce((sum, ch, index) => sum + ch.charCodeAt(0) * (index + 1), 0) % 11;
    const offset = (seed - 5) * 0.012;
    return {
      ...AUTO_PLAY_PROFILE,
      name: `${player?.name || 'Player'} Auto`,
      tightness: clamp(AUTO_PLAY_PROFILE.tightness + offset, 0.45, 0.7),
      bluffFreq: clamp(AUTO_PLAY_PROFILE.bluffFreq + offset * 0.4, 0.03, 0.14),
      aggression: clamp(AUTO_PLAY_PROFILE.aggression - offset * 0.6, 0.42, 0.7),
      cbetFreq: clamp(AUTO_PLAY_PROFILE.cbetFreq - offset * 0.35, 0.45, 0.72),
      checkRaiseFreq: clamp(AUTO_PLAY_PROFILE.checkRaiseFreq + offset * 0.2, 0.03, 0.12),
    };
  }

  buildSolverContextForPlayer(player) {
    if (!player || !player.holeCards || player.holeCards.length !== 2) return null;
    return buildSolverContext({
      players: this.players,
      currentPlayerId: player.id,
      dealerIndex: this.dealerIndex,
      bbIndex: this.bbIndex,
      handStartPlayerCount: this.handStartPlayerCount,
      handStartStacks: this.handStartStacks,
      handActionLog: this.handActionLog,
      bigBlind: this.bigBlind,
      phase: this.phase,
      communityCards: this.communityCards,
    });
  }

  prewarmSolverTreeForPlayer(player) {
    const solverContext = this.buildSolverContextForPlayer(player);
    if (!solverContext) return null;
    return warmStrategyTree({
      solverContext,
      holeCards: player.holeCards,
      dataDir: this.solverDataDir || undefined,
      rootCacheDir: this.solverRootCacheDir || undefined,
    });
  }

  prewarmSolverTreesForStreet() {
    for (const player of this.players) {
      if (!player.isNPC || player.folded || player.allIn) continue;
      if (!player.holeCards || player.holeCards.length !== 2) continue;
      this.prewarmSolverTreeForPlayer(player);
    }
  }

  processNPCTurn() {
    const current = this.players[this.currentPlayerIndex];
    if (!current || !this.isAutomatedPlayer(current) || current.folded || current.allIn) return;

    // Paused: mark automated turn as pending
    if (this.isPaused) {
      this._pausedNpcPending = true;
      return;
    }

    // NPC delay scaled by speed multiplier
    const baseMin = NPC_DELAY_MIN,
      baseMax = NPC_DELAY_MAX;
    const mult = this.speedMultiplier || 1;
    const delayMin = baseMin / mult;
    const delayMax = baseMax / mult;
    const delay =
      delayMin >= delayMax ? Math.round(delayMin) : Math.round(delayMin + random.randomInt(Math.max(1, Math.round(delayMax - delayMin) + 1)));

    if (current.isNPC && current.holeCards && current.holeCards.length === 2) {
      this.prewarmSolverTreeForPlayer(current);
    }

    if (this._npcTimer) {
      clearTimeout(this._npcTimer);
      this._npcTimer = null;
    }
    this.turnDurationMs = delay;
    this.turnExpiresAt = Date.now() + delay;
    this.emitUpdate();

    this._npcTimer = setTimeout(async () => {
      // Room cleaned up or game stopped
      if (!this.isRunning) return;
      const liveCurrent = this.players[this.currentPlayerIndex];
      if (!liveCurrent || liveCurrent.id !== current.id || !this.isAutomatedPlayer(liveCurrent)) {
        return;
      }
      // Pause check (timer may fire after pause)
      if (this.isPaused) {
        this._pausedNpcPending = true;
        return;
      }

      // Build opponent action histories for range estimation
      const opponentActions = {};
      const opponentProfiles = {};
      for (const p of this.players) {
        if (p.id !== current.id && !p.folded) {
          opponentActions[p.id] = this.handActionHistory[p.id] || [];
          opponentProfiles[p.id] = this.playerStats.getProfile(p.id);
        }
      }

      const decisionProfile = current.isNPC
        ? current.npcProfile
        : this.getAutoPlayProfile(current);
      const solverContext = this.buildSolverContextForPlayer(current);

      const gameState = {
        pot: this.pot,
        currentBet: this.currentBet,
        playerBet: current.bet,
        chips: current.chips,
        minRaise: this.currentBet + this.minRaise,
        phase: this.phase,
        roundCount: this.roundCount,
        activePlayers: this.getPlayersInHand().length,
        seatIndex: current.seatIndex,
        dealerIndex: this.dealerIndex,
        sbIndex: this.sbIndex,
        bbIndex: this.bbIndex,
        totalPlayers: this.players.filter((p) => !p.folded).length,
        bigBlind: this.bigBlind,
        currentPlayerId: current.id,
        handActionLog: this.handActionLog,
        handStartPlayerCount: this.handStartPlayerCount,
        handStartStacks: this.handStartStacks,
        solverDataDir: this.solverDataDir || undefined,
        solverContext,
        // Opponent modeling data
        opponentActions,
        opponentProfiles,
        solverRootCacheDir: this.solverRootCacheDir || undefined,
        _wasPreRaiser: this.preflopRaiserId === current.id,
        // Preflop lookup table (injected by server)
        preflopTable: this.preflopTable,
        // Veteran thinking data
        _myHandActions: this.handActionHistory[current.id] || [],
        _myRecentActions: current._recentActions || [],
        // Psychology modifiers
        psychMods: current.isNPC
          ? current.npcProfile
            ? this.npcPsychology.getDecisionModifiers(
                current.id,
                this.players.find((p) => !p.isNPC && !p.folded)?.id || null,
                current.npcProfile
              )
            : null
          : null,
      };

      // Unified orchestrator: solver exact hit -> remote model -> local fallback
      let decision;
      try {
        decision = await decideNpcAction({
          profile: decisionProfile,
          holeCards: current.holeCards,
          communityCards: this.communityCards,
          gameState,
          players: this.players,
          pokerSkillConfig: this.pokerSkillConfig || undefined,
          remoteConfig: this.npcModelConfig || undefined,
        });
      } catch (e) {
        this._log(
          `⚠️ ${current.name}${current.isNPC ? '' : ' [auto]'} decision error: ${e.message}, falling back to check/fold`
        );
        const canCheck = this.currentBet <= current.bet;
        decision = canCheck ? { action: 'check' } : { action: 'fold' };
      }

      const postAwaitCurrent = this.players[this.currentPlayerIndex];
      if (!this.isRunning || !postAwaitCurrent || postAwaitCurrent.id !== current.id) {
        return;
      }

      if (gameState._decisionTrace?.status === 'solver_hit') {
        this._logEvent(
          'solver_hit',
          {
            playerId: current.id,
            playerName: current.name,
            isNPC: current.isNPC,
            ...gameState._decisionTrace,
          },
          'info',
          'Solver strategy applied'
        );
        this.recordRuntimeRolloutDecision(gameState._decisionTrace, gameState._solverTrace || null);
      } else if (gameState._decisionTrace?.status === 'pokerskill_hit') {
        this._logEvent(
          'pokerskill_hit',
          {
            playerId: current.id,
            playerName: current.name,
            isNPC: current.isNPC,
            ...gameState._decisionTrace,
          },
          'info',
          'PokerSkill harness applied'
        );
        this.recordRuntimeRolloutDecision(gameState._decisionTrace, gameState._solverTrace || null);
      } else if (gameState._decisionTrace?.status === 'model_hit') {
        this._logEvent(
          'model_hit',
          {
            playerId: current.id,
            playerName: current.name,
            isNPC: current.isNPC,
            ...gameState._decisionTrace,
          },
          'info',
          'Remote model strategy applied'
        );
        this.recordRuntimeRolloutDecision(gameState._decisionTrace, gameState._solverTrace || null);
      } else if (gameState._decisionTrace?.status === 'fallback') {
        this._logEvent(
          'decision_fallback',
          {
            playerId: current.id,
            playerName: current.name,
            isNPC: current.isNPC,
            ...gameState._decisionTrace,
            solverTrace: gameState._solverTrace || null,
          },
          gameState._decisionTrace.coverageStatus === 'covered_spot' ? 'info' : 'debug',
          'Decision fallback used'
        );
        this.recordRuntimeRolloutDecision(gameState._decisionTrace, gameState._solverTrace || null);
      }
      this._log(
        `📋 ${current.name}${current.isNPC ? '' : ' [auto]'}${decision._solver ? ' [solver]' : decision._pokerskill ? ' [pokerskill]' : decision._model ? ' [model]' : ''}: ${decision.action}${decision.amount ? ' ' + decision.amount : ''}`
      );

      // Store last action for display (including fallback decisions)
      current.lastAction = { action: decision.action, amount: decision.amount, time: Date.now() };

      // Psychology-driven chat
      if (current.isNPC) {
        const situation =
          decision.action === 'fold' ? 'folded' : decision._isBluffing ? 'bluffing' : 'normal';
        const chatMsg = this.npcPsychology.generateChat(current.id, current.npcProfile, situation);
        if (chatMsg && this.onChat) {
          this.onChat(current.name, chatMsg);
        }
      }

      this.handleAction(current.id, decision.action, decision.amount);
    }, delay);
    if (this._npcTimer.unref) this._npcTimer.unref();
  }

  getStateForPlayer(playerId) {
    const viewer = this.players.find((p) => p.id === playerId);
    return {
      id: this.id,
      phase: this.phase,
      pot: this.pot,
      communityCards: this.communityCards,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      dealerIndex: this.dealerIndex,
      sbIndex: this.sbIndex,
      bbIndex: this.bbIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      roundCount: this.roundCount,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      hostName: this.hostPlayerName || null,
      isHost: !!(viewer && viewer.name === this.hostPlayerName),
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        totalBet: p.totalBet,
        folded: p.folded,
        allIn: p.allIn,
        isNPC: p.isNPC,
        npcProfile: p.isNPC
          ? {
              style: p.npcProfile?.style || 'balanced',
              avatar: p.npcProfile?.avatar || '🤖',
              title: p.npcProfile?.title || '',
              titleEn: p.npcProfile?.titleEn || '',
              bio: p.npcProfile?.bio || '',
              bioEn: p.npcProfile?.bioEn || '',
              origin: p.npcProfile?.origin || '',
              originEn: p.npcProfile?.originEn || '',
              nameEn: p.npcProfile?.nameEn || p.name,
              isWestern: p.npcProfile?.isWestern || false,
            }
          : null,
        seatIndex: p.seatIndex,
        isConnected: p.isConnected,
        isReady: !!p.isReady,
        autoPlay: !!p.autoPlay,
        isSpectator: this.isSpectatorPlayer(p),
        avatar: p.avatar || null,
        lastAction: p.lastAction || null,
        wins: p.wins,
        handsPlayed: p.handsPlayed,
        // Only show hole cards to the player themselves, or during showdown
        holeCards:
          p.id === playerId || (this.phase === 'showdown' && !p.folded) ? p.holeCards : null,
      })),
      isMyTurn: viewer && this.currentPlayerIndex === viewer.seatIndex && this.isRunning,
      canCheck: viewer && this.currentBet === (viewer.bet || 0),
      canRaise: viewer
        ? this.players.some((p) => p.id !== playerId && !p.folded && !p.allIn && p.chips > 0)
        : false,
      toCall: viewer ? this.currentBet - (viewer.bet || 0) : 0,
      isRunning: this.isRunning,
      lastRoundWinnerIds: this.lastRoundWinnerIds,
      lastRoundRefunds: this.lastRoundRefunds,
      // War report & leaderboard
      warReport: this.lastWarReport || null,
      leaderboard: this.leaderboard.getRankings(),
      recentHands: this.handHistory.getRecentHands(10).map((h) => ({
        handNum: h.handNum,
        pot: h.pot,
        phase: h.finalPhase,
        winners: h.winners,
        communityCards: h.communityCards,
        holeCards: h.holeCards,
        actions: h.actions,
        players: h.players,
        dealerIndex: h.dealerIndex,
        sbIndex: h.sbIndex,
        bbIndex: h.bbIndex,
        smallBlind: h.smallBlind,
        bigBlind: h.bigBlind,
      })),
      // Tournament
      tournament: this.tournament ? this.tournament.getState() : null,
      gameOver: this.gameOver,
      viewerIsSpectator: this.isSpectatorPlayer(viewer),
      turnExpiresAt: this.turnExpiresAt,
      turnDurationMs: this.turnDurationMs,
      // v11
      gameMode: this.gameMode,
      isPaused: this.isPaused,
      speedMultiplier: this.speedMultiplier,
      equityState: this.equityState[playerId] || { freeLeft: 3, priceLevel: 0, unusedStreak: 0 },
      equityPrice: this._equityPrice((this.equityState[playerId] || { priceLevel: 0 }).priceLevel),
    };
  }

  emitUpdate() {
    if (this.onUpdate) this.onUpdate(this);
  }

  emitMessage(msg) {
    if (this.onMessage) this.onMessage(msg);
  }
}

module.exports = { PokerGame };
