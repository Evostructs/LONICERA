// npc.js - AI v5: Range-Weighted MC (1000 sims) + Preflop Lookup Table + Opponent Adaptation
const { createDeck, shuffle } = require('./deck');
const { evaluateHand, compareHands, HAND_RANKS } = require('./hand-eval');
const { generateVeteranRead, applyVeteranRead } = require('./veteran');
const { generateStrategy } = require('./strategy');
const {
  chartBasedPreflopDecision,
  riverPolarizedDecision,
  getHandTier,
} = require('./preflop-charts');
const { estimateRange, sampleFromRange } = require('./range');
const { lookupPreflopEquity } = require('./preflop-table');
const { lookupStrategyDetailed } = require('./solver-lookup');
const { isSolverEligibleProfile, applyPersonaDeviation } = require('./solver-persona');
const { solverDecisionFromStrategy } = require('./solver-translate');

// ============================================================
//  NPC CHARACTER PROFILES - Classic Literary Characters
// ============================================================

const NPC_PROFILES = [
  // ---- 三国演义 ----
  {
    name: '诸葛亮',
    style: 'tricky',
    avatar: '🪶',
    tightness: 0.5,
    bluffFreq: 0.35,
    aggression: 0.6,
    cbetFreq: 0.7,
    checkRaiseFreq: 0.25,
    title: '卧龙先生',
    nameEn: 'Zhuge Liang',
    titleEn: 'The Sleeping Dragon',
    bioEn:
      'Foresaw the tripartite before leaving his hut. A master of deception at the table — feigns weakness to lure, bluffs to dominate. You never know what he holds.',
    bio: '未出茅庐而知三分天下。牌桌上运筹帷幄，善于伪装牌力，时而示弱诱敌，时而虚张声势，让人永远猜不透他的底牌。',
    origin: '三国演义',
    originEn: 'Romance of the Three Kingdoms',
  },
  {
    name: '曹操',
    style: 'aggressive',
    avatar: '👑',
    tightness: 0.4,
    bluffFreq: 0.3,
    aggression: 0.85,
    cbetFreq: 0.8,
    checkRaiseFreq: 0.1,
    title: '乱世枭雄',
    nameEn: 'Cao Cao',
    titleEn: 'The Warlord',
    bioEn:
      'Would rather betray the world than let it betray him. Ruthless aggression, crushing pressure with strong hands, and bold raises even with marginal ones.',
    bio: '宁教我负天下人。打牌风格凶狠果断，持强牌时压迫力极大，即使牌力一般也敢大胆加注，气势上从不输人。',
    origin: '三国演义',
    originEn: 'Romance of the Three Kingdoms',
  },
  {
    name: '关羽',
    style: 'rock',
    avatar: '⚔️',
    tightness: 0.8,
    bluffFreq: 0.05,
    aggression: 0.5,
    cbetFreq: 0.4,
    checkRaiseFreq: 0.05,
    title: '武圣',
    nameEn: 'Guan Yu',
    titleEn: 'The God of War',
    bioEn:
      'Loyal as steel, patient as stone. Only strikes with premium hands, but when he does — devastating force. If he raises, think twice before calling.',
    bio: '义薄云天，心如磐石。只在拿到好牌时出手，一旦出手便雷霆万钧。几乎从不诈唬，但他下注时你最好认真考虑弃牌。',
    origin: '三国演义',
    originEn: 'Romance of the Three Kingdoms',
  },
  {
    name: '张飞',
    style: 'maniac',
    avatar: '🔥',
    tightness: 0.2,
    bluffFreq: 0.5,
    aggression: 0.95,
    cbetFreq: 0.85,
    checkRaiseFreq: 0.15,
    title: '猛张飞',
    nameEn: 'Zhang Fei',
    titleEn: 'The Berserker',
    bioEn:
      'Zhang Fei of Yan is here! Plays like he fights — wild, fearless, all-in on anything. You either fold to his fury or watch him crash and burn.',
    bio: '燕人张翼德在此！打牌如打仗，风风火火，什么牌都敢打，什么注都敢加。对手要么被他的气势吓退，要么看他表演翻车。',
    origin: '三国演义',
    originEn: 'Romance of the Three Kingdoms',
  },
  {
    name: '赵云',
    style: 'balanced',
    avatar: '🐉',
    tightness: 0.5,
    bluffFreq: 0.2,
    aggression: 0.6,
    cbetFreq: 0.6,
    checkRaiseFreq: 0.12,
    title: '常胜将军',
    nameEn: 'Zhao Yun',
    titleEn: 'The Invincible',
    bioEn:
      'Charged through an army seven times. Balanced, precise, rarely makes mistakes. Finding his weakness is like finding a crack in perfect armor.',
    bio: '七进七出，浑身是胆。打法全面均衡，攻守兼备，很少犯错。你很难从他身上找到弱点，就像找不到他盔甲的缝隙一样。',
    origin: '三国演义',
    originEn: 'Romance of the Three Kingdoms',
  },
  // ---- 西游记 ----
  {
    name: '孙悟空',
    style: 'aggressive',
    avatar: '🐵',
    tightness: 0.35,
    bluffFreq: 0.25,
    aggression: 0.8,
    cbetFreq: 0.75,
    checkRaiseFreq: 0.18,
    title: '齐天大圣',
    nameEn: 'Sun Wukong',
    titleEn: 'The Monkey King',
    bioEn:
      '72 transformations, golden eyes. Unpredictable and explosive, delivers killing blows at the perfect moment. Chips are his golden staff.',
    bio: '七十二变，火眼金睛。打法灵活多变，擅长在关键时刻给出致命一击。敢于挑战任何对手，筹码就是他的金箍棒。',
    origin: '西游记',
    originEn: 'Journey to the West',
  },
  {
    name: '唐僧',
    style: 'passive',
    avatar: '📿',
    tightness: 0.75,
    bluffFreq: 0.05,
    aggression: 0.15,
    cbetFreq: 0.2,
    checkRaiseFreq: 0.02,
    title: '三藏法师',
    nameEn: 'Tang Sanzang',
    titleEn: 'The Pilgrim Monk',
    bioEn:
      'Compassionate, never aggressive. Extremely passive play, rarely raises, but occasionally shows surprising resolve. Loses gracefully.',
    bio: '心怀慈悲，不争不抢。打牌极为保守，很少主动加注，但偶尔会在关键时刻展现出令人意外的坚持。输了也不生气。',
    origin: '西游记',
    originEn: 'Journey to the West',
  },
  // ---- 水浒传 ----
  {
    name: '鲁智深',
    style: 'maniac',
    avatar: '🍺',
    tightness: 0.25,
    bluffFreq: 0.45,
    aggression: 0.9,
    cbetFreq: 0.8,
    checkRaiseFreq: 0.1,
    title: '花和尚',
    nameEn: 'Lu Zhishen',
    titleEn: 'The Tattooed Monk',
    bioEn:
      'Uprooted a willow tree barehanded — now he pounds the table. Big drinks, big bets. Acts first, thinks later. Lovably reckless.',
    bio: '倒拔垂杨柳的力气，用在了拍桌子上。大碗喝酒大把下注，管你什么牌型概率，先加了再说！豪爽到让人又爱又恨。',
    origin: '水浒传',
    originEn: 'Water Margin',
  },
  {
    name: '吴用',
    style: 'balanced',
    avatar: '🎯',
    tightness: 0.5,
    bluffFreq: 0.2,
    aggression: 0.55,
    cbetFreq: 0.6,
    checkRaiseFreq: 0.15,
    title: '智多星',
    nameEn: 'Wu Yong',
    titleEn: 'The Strategist',
    bioEn:
      "Liangshan's chief advisor. Balanced and seasoned — you cannot find a tell. Shifts gears between tight and loose seamlessly.",
    bio: '梁山军师，算无遗策。打牌均衡老练，很难从他身上找到破绽。既能紧手等待好牌，也能松手制造压力，深藏不露。',
    origin: '水浒传',
    originEn: 'Water Margin',
  },
  {
    name: '林冲',
    style: 'tight',
    avatar: '🐆',
    tightness: 0.7,
    bluffFreq: 0.1,
    aggression: 0.45,
    cbetFreq: 0.5,
    checkRaiseFreq: 0.08,
    title: '豹子头',
    nameEn: 'Lin Chong',
    titleEn: 'The Panther',
    bioEn:
      'Commander of 800,000 troops, master of patience. Waits for the best spots, but when cornered, unleashes terrifying power.',
    bio: '八十万禁军教头，隐忍功夫天下第一。只在最有把握时出手，但被逼到绝境也会爆发出惊人的力量。',
    origin: '水浒传',
    originEn: 'Water Margin',
  },
  // ---- 红楼梦 ----
  {
    name: '王熙凤',
    style: 'aggressive',
    avatar: '🦊',
    tightness: 0.38,
    bluffFreq: 0.3,
    aggression: 0.78,
    cbetFreq: 0.75,
    checkRaiseFreq: 0.2,
    title: '凤辣子',
    nameEn: 'Wang Xifeng',
    titleEn: 'The Phoenix',
    bioEn:
      "Sharp-tongued, sharper mind. Reads opponents like ledgers, strikes at the optimal moment. Don't be fooled by her smile.",
    bio: '机关算尽，精明强干。牌桌上八面玲珑，善于察言观色，总能在最佳时机发起进攻。不要被她的笑容骗了，她下手可不留情。',
    origin: '红楼梦',
    originEn: 'Dream of the Red Chamber',
  },
  {
    name: '贾宝玉',
    style: 'passive',
    avatar: '🦋',
    tightness: 0.55,
    bluffFreq: 0.1,
    aggression: 0.25,
    cbetFreq: 0.3,
    checkRaiseFreq: 0.03,
    title: '怡红公子',
    nameEn: 'Jia Baoyu',
    titleEn: 'The Jade Prince',
    bioEn:
      'A romantic soul who barely pays attention. Calls to see what happens, occasionally surprises everyone. Wins and losses mean nothing to him.',
    bio: '温柔多情的富家公子。打牌不太上心，经常跟注看看热闹，偶尔心血来潮会有惊人之举。输赢都不太在意，图个开心。',
    origin: '红楼梦',
    originEn: 'Dream of the Red Chamber',
  },
  // ---- 荷马史诗 ----
  {
    name: '奥德修斯',
    style: 'tricky',
    avatar: '🏛️',
    tightness: 0.48,
    bluffFreq: 0.35,
    aggression: 0.65,
    cbetFreq: 0.7,
    checkRaiseFreq: 0.22,
    title: '千面英雄',
    nameEn: 'Odysseus',
    titleEn: 'The Man of Many Faces',
    bioEn:
      "Architect of the Trojan Horse. Endless deception at the table — shows weakness with monsters, strength with air. Is he bluffing? Maybe this time he isn't.",
    bio: '特洛伊木马的策划者。牌桌上诡计多端——拿到大牌装弱，拿到烂牌演强。你以为他在诈唬？也许这次他是真的。',
    isWestern: true,
    origin: '荷马史诗',
    originEn: "Homer's Epics",
  },
  {
    name: '阿喀琉斯',
    style: 'aggressive',
    avatar: '🛡️',
    tightness: 0.35,
    bluffFreq: 0.2,
    aggression: 0.88,
    cbetFreq: 0.82,
    checkRaiseFreq: 0.08,
    title: '战神之子',
    nameEn: 'Achilles',
    titleEn: 'Son of War',
    bioEn:
      "Greece's greatest warrior, invulnerable everywhere but one spot. Always charges forward with massive raises. His weakness? Sometimes too confident.",
    bio: '希腊第一勇士，除了脚踵哪都硬。打牌永远冲在前面，大额加注是家常便饭。弱点？有时候太自信，会被反套路。',
    isWestern: true,
    origin: '荷马史诗',
    originEn: "Homer's Epics",
  },
  // ---- 莎士比亚 ----
  {
    name: '哈姆雷特',
    style: 'balanced',
    avatar: '💀',
    tightness: 0.52,
    bluffFreq: 0.18,
    aggression: 0.5,
    cbetFreq: 0.55,
    checkRaiseFreq: 0.12,
    title: '丹麦王子',
    nameEn: 'Hamlet',
    titleEn: 'The Danish Prince',
    bioEn:
      'To bet or not to bet. Hesitates endlessly, but once decided — unshakeable conviction. His indecision is both his flaw and his disguise.',
    bio: 'To bet or not to bet, that is the question. 犹豫不决是他的标签，但一旦下定决心就无比坚定。',
    isWestern: true,
    origin: '莎士比亚',
    originEn: 'Shakespeare',
  },
  {
    name: '麦克白',
    style: 'aggressive',
    avatar: '🗡️',
    tightness: 0.4,
    bluffFreq: 0.28,
    aggression: 0.82,
    cbetFreq: 0.78,
    checkRaiseFreq: 0.12,
    title: '野心之王',
    nameEn: 'Macbeth',
    titleEn: 'The Ambitious King',
    bioEn:
      'Driven by ambition for the biggest pots. Skilled but greedy — overreaches when he should fold. Prophecy or ruin.',
    bio: '被野心驱使的苏格兰领主。牌桌上野心勃勃，总想赢下最大的底池。有实力，但贪心有时会害了他。',
    isWestern: true,
    origin: '莎士比亚',
    originEn: 'Shakespeare',
  },
  // ── 楚汉争霸 ──
  {
    name: '项羽',
    style: 'maniac',
    avatar: '⚡',
    tightness: 0.25,
    bluffFreq: 0.35,
    aggression: 0.95,
    cbetFreq: 0.85,
    checkRaiseFreq: 0.2,
    title: '西楚霸王',
    nameEn: 'Xiang Yu',
    titleEn: 'The Hegemon-King',
    bioEn:
      'Strength to uproot mountains. All-or-nothing at the table — massive victories or spectacular defeats. Despises small pots.',
    bio: '力拔山兮气盖世。打牌如打仗，一往无前，要么大胜要么大败，从不知退缩为何物。不屑于小底池。',
    origin: '楚汉争霸',
    originEn: 'Chu-Han Contention',
  },
  {
    name: '刘邦',
    style: 'tricky',
    avatar: '🐍',
    tightness: 0.5,
    bluffFreq: 0.3,
    aggression: 0.55,
    cbetFreq: 0.6,
    checkRaiseFreq: 0.2,
    title: '草莽天子',
    nameEn: 'Liu Bang',
    titleEn: 'The Rogue Emperor',
    bioEn:
      'Rose from nothing to rule the world. Flexible, deceptive — shows weakness before the killing blow. Nearly impossible to bluff.',
    bio: '出身市井却能驭天下英才。牌桌上能屈能伸，示弱是为了致命一击。擅长读人，极难被诈唬。',
    origin: '楚汉争霸',
    originEn: 'Chu-Han Contention',
  },
  {
    name: '韩信',
    style: 'balanced',
    avatar: '🎖️',
    tightness: 0.55,
    bluffFreq: 0.2,
    aggression: 0.7,
    cbetFreq: 0.7,
    checkRaiseFreq: 0.18,
    title: '兵仙',
    nameEn: 'Han Xin',
    titleEn: 'The God of War',
    bioEn:
      'Peerless general. Every hand is a military campaign — multi-street planning, precise value bets. The more chips, the better.',
    bio: '国士无双，用兵如神。牌桌上算无遗策，每一手都像在排兵布阵。擅长多街规划和精准价值下注。',
    origin: '楚汉争霸',
    originEn: 'Chu-Han Contention',
  },
  {
    name: '张良',
    style: 'tight',
    avatar: '🪭',
    tightness: 0.72,
    bluffFreq: 0.15,
    aggression: 0.45,
    cbetFreq: 0.5,
    checkRaiseFreq: 0.15,
    title: '谋圣',
    nameEn: 'Zhang Liang',
    titleEn: 'The Grand Strategist',
    bioEn:
      'Plans within plans, patience beyond measure. Only acts with certainty. When he raises, he means it.',
    bio: '运筹帷幄之中，决胜千里之外。极度有耐心，只在确定占优时出手。一旦加注，说明他真的有货。',
    origin: '楚汉争霸',
    originEn: 'Chu-Han Contention',
  },
  {
    name: '范增',
    style: 'aggressive',
    avatar: '🧓',
    tightness: 0.45,
    bluffFreq: 0.25,
    aggression: 0.75,
    cbetFreq: 0.72,
    checkRaiseFreq: 0.15,
    title: '亚父',
    nameEn: 'Fan Zeng',
    titleEn: 'The Elder Advisor',
    bioEn:
      'The shrewdest mind beside the Hegemon. Reads situations perfectly but acts too hastily. Wisdom undermined by temper.',
    bio: '项羽身边最老辣的谋士。看得准但急性子，经常在该等的时候暴露意图。智慧被脾气拖了后腿。',
    origin: '楚汉争霸',
    originEn: 'Chu-Han Contention',
  },
  {
    name: '虞姬',
    style: 'passive',
    avatar: '🌸',
    tightness: 0.6,
    bluffFreq: 0.08,
    aggression: 0.2,
    cbetFreq: 0.3,
    checkRaiseFreq: 0.05,
    title: '霸王别姬',
    nameEn: 'Yu Ji',
    titleEn: 'The Farewell Concubine',
    bioEn:
      'Appears gentle, thinks ruthlessly. Lulls opponents into comfort, then strikes with precision. The most dangerous smile at the table.',
    bio: '看似温婉实则心思缜密。牌桌上善于伪装，让对手放松警惕后精准出击。笑着收割筹码，是牌桌上最危险的那种人。',
    origin: '楚汉争霸',
    originEn: 'Chu-Han Contention',
  },
];

const MC_SIMULATIONS = 1000;

// ============================================================
//  RANGE-WEIGHTED MONTE CARLO EQUITY
// ============================================================

function rangeWeightedMC(holeCards, communityCards, opponentRanges, numSims = MC_SIMULATIONS) {
  const knownCards = [...holeCards, ...communityCards];
  const knownSet = new Set(knownCards.map((c) => c.rank + c.suit));
  const baseDeck = createDeck().filter((c) => !knownSet.has(c.rank + c.suit));

  let wins = 0,
    ties = 0,
    validSims = 0;

  for (let sim = 0; sim < numSims; sim++) {
    const oppHands = [];
    const usedCards = new Set(knownSet);
    let valid = true;

    for (const range of opponentRanges) {
      let sampled = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = sampleFromRange(range);
        if (!candidate) {
          valid = false;
          break;
        }
        if (
          !usedCards.has(candidate[0].rank + candidate[0].suit) &&
          !usedCards.has(candidate[1].rank + candidate[1].suit)
        ) {
          sampled = candidate;
          usedCards.add(candidate[0].rank + candidate[0].suit);
          usedCards.add(candidate[1].rank + candidate[1].suit);
          break;
        }
      }
      if (!sampled) {
        valid = false;
        break;
      }
      oppHands.push(sampled);
    }

    if (!valid) continue;
    validSims++;

    const available = baseDeck.filter((c) => !usedCards.has(c.rank + c.suit));
    const shuffled = shuffleFast(available);
    const simBoard = [...communityCards];
    let idx = 0;
    while (simBoard.length < 5) simBoard.push(shuffled[idx++]);

    const myHand = evaluateHand([...holeCards, ...simBoard]);
    let best = true,
      tied = false;
    for (const oppHole of oppHands) {
      const oppHand = evaluateHand([...oppHole, ...simBoard]);
      const cmp = compareHands(myHand, oppHand);
      if (cmp < 0) {
        best = false;
        break;
      }
      if (cmp === 0) tied = true;
    }
    if (best && !tied) wins++;
    else if (best && tied) ties++;
  }

  const effectiveSims = Math.max(1, validSims);
  return {
    equity: (wins + ties * 0.5) / effectiveSims,
    winRate: wins / effectiveSims,
    tieRate: ties / effectiveSims,
  };
}

function vanillaMC(holeCards, communityCards, numOpponents, numSims = MC_SIMULATIONS) {
  const knownSet = new Set([...holeCards, ...communityCards].map((c) => c.rank + c.suit));
  const baseDeck = createDeck().filter((c) => !knownSet.has(c.rank + c.suit));

  let wins = 0,
    ties = 0;
  for (let sim = 0; sim < numSims; sim++) {
    const deck = shuffleFast(baseDeck);
    let idx = 0;
    const simBoard = [...communityCards];
    while (simBoard.length < 5) simBoard.push(deck[idx++]);

    const myHand = evaluateHand([...holeCards, ...simBoard]);
    let best = true,
      tied = false;
    for (let o = 0; o < numOpponents; o++) {
      const oppHand = evaluateHand([deck[idx++], deck[idx++], ...simBoard]);
      if (compareHands(myHand, oppHand) < 0) {
        best = false;
        break;
      }
      if (compareHands(myHand, oppHand) === 0) tied = true;
    }
    if (best && !tied) wins++;
    else if (best && tied) ties++;
  }
  return {
    equity: (wins + ties * 0.5) / Math.max(1, numSims),
    winRate: wins / numSims,
    tieRate: ties / numSims,
  };
}

function shuffleFast(arr) {
  const d = [...arr];
  for (let i = d.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const tmp = d[i];
    d[i] = d[j];
    d[j] = tmp;
  }
  return d;
}

// ============================================================
//  POSITION AWARENESS
// ============================================================

function getPositionFactor(seatIndex, dealerIndex, totalPlayers) {
  const safePlayers = Math.max(1, totalPlayers);
  const rel = ((seatIndex - dealerIndex + safePlayers) % safePlayers) / safePlayers;
  if (rel < 0.33) return 0.7 + rel * 0.45;
  if (rel < 0.66) return 0.85 + (rel - 0.33) * 0.45;
  return 1.0 + (rel - 0.66) * 0.75;
}

function getPositionName(seatIndex, dealerIndex, totalPlayers) {
  const seats = (seatIndex - dealerIndex + totalPlayers) % totalPlayers;
  const ratio = seats / Math.max(1, totalPlayers);
  if (seats === 0) return 'dealer';
  if (seats === 1) return 'sb';
  if (seats === 2) return 'bb';
  if (ratio < 0.33) return 'early';
  if (ratio < 0.66) return 'middle';
  return 'late';
}

// ============================================================
//  DRAW / OUTS
// ============================================================

function calculateOuts(holeCards, communityCards) {
  if (communityCards.length === 0 || communityCards.length === 5)
    return { outs: 0, drawType: 'none', drawStrength: 0, draws: [] };

  const allCards = [...holeCards, ...communityCards];
  const currentHand = evaluateHand(allCards);
  let totalOuts = 0;
  const draws = [];

  const suitCounts = {};
  for (const c of allCards) suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
  for (const [suit, count] of Object.entries(suitCounts)) {
    if (count === 4) {
      draws.push({ type: 'flush_draw', outs: 9 });
      totalOuts += 9;
      break;
    }
    if (count === 3 && allCards.length === 5) {
      draws.push({ type: 'backdoor_flush', outs: 3 });
      totalOuts += 3;
      break;
    }
  }

  const values = [...new Set(allCards.map((c) => c.value))].sort((a, b) => a - b);
  if (values.includes(14)) values.unshift(1);
  let foundStraight = false;
  for (let i = 0; i <= values.length - 4 && !foundStraight; i++) {
    if (values[i + 3] - values[i] === 3) {
      const low = values[i],
        high = values[i + 3];
      if (low > 1 && high < 14) {
        draws.push({ type: 'oesd', outs: 8 });
        totalOuts += 8;
      } else {
        draws.push({ type: 'gutshot', outs: 4 });
        totalOuts += 4;
      }
      foundStraight = true;
    }
  }
  if (!foundStraight) {
    for (let t = 1; t <= 10; t++) {
      const w = [t, t + 1, t + 2, t + 3, t + 4];
      if (w.filter((v) => values.includes(v) || (v === 1 && values.includes(14))).length === 4) {
        draws.push({ type: 'gutshot', outs: 4 });
        totalOuts += 4;
        break;
      }
    }
  }

  if (currentHand.rank <= HAND_RANKS.HIGH_CARD && communityCards.length > 0) {
    const boardMax = Math.max(...communityCards.map((c) => c.value));
    let overOuts = holeCards.filter((c) => c.value > boardMax).length * 3;
    if (overOuts) {
      draws.push({ type: 'overcards', outs: overOuts });
      totalOuts += overOuts;
    }
  }

  if (currentHand.rank === HAND_RANKS.ONE_PAIR) {
    draws.push({ type: 'pair_improve', outs: 5 });
    totalOuts += 5;
  }

  if (draws.length > 1) totalOuts = Math.round(totalOuts * 0.85);

  let drawType = 'none',
    drawStrength = 0;
  if (draws.length > 0) {
    draws.sort((a, b) => b.outs - a.outs);
    drawType = draws.length > 1 ? 'combo_draw' : draws[0].type;
    const mult = communityCards.length === 3 ? 4 : 2;
    drawStrength = Math.min(0.6, (totalOuts * mult) / 100);
  }
  return { outs: totalOuts, drawType, drawStrength, draws };
}

// ============================================================
//  PREFLOP HAND STRENGTH
// ============================================================

function evaluatePreflop(holeCards) {
  const [c1, c2] = holeCards;
  const isPair = c1.value === c2.value;
  const isSuited = c1.suit === c2.suit;
  const high = Math.max(c1.value, c2.value);
  const low = Math.min(c1.value, c2.value);
  let s = isPair ? 0.5 + (c1.value / 14) * 0.5 : (high + low) / 28;
  if (!isPair && isSuited) s += 0.06;
  if (!isPair && high - low <= 2) s += 0.04;
  if (!isPair && high - low <= 1) s += 0.03;
  if (!isPair && high >= 12) s += 0.08;
  if (!isPair && high === 14) s += 0.05;
  return Math.min(1, Math.max(0, s));
}

function effectiveToCallAmount(currentBet = 0, playerBet = 0, chips = 0) {
  const rawToCall = Math.max(0, Number(currentBet) - Number(playerBet));
  return Math.min(rawToCall, Math.max(0, Number(chips)));
}

function getPreflopShape(holeCards) {
  const [c1, c2] = holeCards;
  const high = Math.max(c1.value, c2.value);
  const low = Math.min(c1.value, c2.value);
  return {
    high,
    low,
    pair: c1.value === c2.value,
    suited: c1.suit === c2.suit,
  };
}

function isHyperAggressiveProfile(profile = {}) {
  if (!profile || profile.sampleSize < 6) return false;
  return (
    profile.playerType === 'maniac' ||
    profile.pfr >= 0.45 ||
    profile.threeBet >= 0.22 ||
    (profile.vpip >= 0.55 && profile.pfr >= 0.3)
  );
}

function headsUpPreflopDefenseDecision(profile, strength, posName, gs, holeCards) {
  const activePlayers = gs.activePlayers || 0;
  const rawToCall = Math.max(0, gs.currentBet - gs.playerBet);
  const toCall = effectiveToCallAmount(gs.currentBet, gs.playerBet, gs.chips);
  if (activePlayers > 2 || rawToCall <= 0 || toCall <= 0) return null;

  const bb = gs.bigBlind || 20;
  const potOdds = toCall / Math.max(1, gs.pot + toCall);
  const tier = getHandTier(holeCards);
  const shape = getPreflopShape(holeCards);
  const oppProfiles = Object.values(gs.opponentProfiles || {});
  const isVsHyperAggro = oppProfiles.some(isHyperAggressiveProfile);
  const allInPressure = toCall >= gs.chips * 0.85 || rawToCall >= bb * 18;
  const largeRaise = rawToCall >= bb * 8;
  const mediumRaise = rawToCall >= bb * 4;
  const shortStack = gs.chips <= bb * 18;

  const premium = tier <= 2 || strength >= 0.74;
  const strong = tier <= 3 || strength >= 0.66;
  const solid = tier <= 4 || strength >= 0.6 || (shape.pair && shape.high >= 7);
  const playable =
    tier <= 5 ||
    strength >= 0.54 ||
    (shape.pair && shape.high >= 4) ||
    (shape.high === 14 && (shape.suited || shape.low >= 8)) ||
    (shape.high >= 13 && shape.low >= 10);

  if (premium) return { action: 'call', _antiExploit: true };

  if (allInPressure) {
    if (strong) return { action: 'call', _antiExploit: true };
    if (shortStack && (solid || (isVsHyperAggro && playable))) {
      return { action: 'call', _antiExploit: true };
    }
    if (isVsHyperAggro && solid && potOdds <= 0.42) {
      return { action: 'call', _antiExploit: true };
    }
    return null;
  }

  if (largeRaise) {
    if (solid || (isVsHyperAggro && playable && potOdds <= 0.38)) {
      return { action: 'call', _antiExploit: true };
    }
    return null;
  }

  if (mediumRaise) {
    if (solid || (playable && (potOdds <= 0.32 || isVsHyperAggro))) {
      return { action: 'call', _antiExploit: true };
    }
    return null;
  }

  if (playable || potOdds <= 0.24 || (posName === 'blind' && tier <= 6)) {
    return { action: 'call', _antiExploit: true };
  }

  return null;
}

// ============================================================
//  SMART BLUFFING
// ============================================================

function evaluateBluff(profile, holeCards, communityCards, gameState, drawInfo, opponentProfiles) {
  const { pot, currentBet, playerBet, chips, phase, activePlayers } = gameState;
  const toCall = effectiveToCallAmount(currentBet, playerBet, chips);
  let bluffScore = 0;
  let bluffType = 'none';

  const posName = gameState._positionName || 'middle';
  if (posName === 'dealer' || posName === 'late') bluffScore += 0.15;
  else if (posName === 'early') bluffScore -= 0.1;

  if (activePlayers <= 2) bluffScore += 0.15;
  else if (activePlayers === 3) bluffScore += 0.05;
  else if (activePlayers >= 5) bluffScore -= 0.15;

  if (communityCards.length >= 3) bluffScore += evaluateBoardScareLevel(communityCards) * 0.2;

  if (drawInfo.outs >= 8) {
    bluffScore += 0.25;
    bluffType = 'semi_bluff';
  } else if (drawInfo.outs >= 4) {
    bluffScore += 0.12;
    bluffType = 'semi_bluff';
  }

  if (phase === 'flop' && gameState._wasPreRaiser) {
    bluffScore += 0.2;
    if (bluffType === 'none') bluffType = 'cbet';
  }

  if (toCall > chips * 0.4) bluffScore -= 0.3;

  if (communityCards.length >= 3) bluffScore += evaluateBlockers(holeCards, communityCards);

  if (opponentProfiles && opponentProfiles.length > 0) {
    const avgFoldToRaise =
      opponentProfiles.reduce((sum, p) => sum + (p.foldToRaise || 0.45), 0) /
      Math.max(1, opponentProfiles.length);
    if (avgFoldToRaise > 0.55) bluffScore += 0.15;
    else if (avgFoldToRaise > 0.5) bluffScore += 0.08;
    else if (avgFoldToRaise < 0.3) bluffScore -= 0.2;

    const nitCount = opponentProfiles.filter((p) => p.playerType === 'nit').length;
    if (nitCount > 0) bluffScore += 0.1 * nitCount;
    const stationCount = opponentProfiles.filter((p) => p.playerType === 'calling_station').length;
    if (stationCount > 0) bluffScore -= 0.15 * stationCount;
  }

  const finalChance = Math.max(0, Math.min(0.7, profile.bluffFreq + bluffScore));
  const shouldBluff = Math.random() < finalChance;

  let bluffSizeMultiplier = 0.5;
  if (shouldBluff) {
    if (bluffType === 'semi_bluff') bluffSizeMultiplier = 0.6 + Math.random() * 0.4;
    else if (bluffType === 'cbet') bluffSizeMultiplier = 0.4 + Math.random() * 0.3;
    else bluffSizeMultiplier = 0.33 + Math.random() * 0.34;
  }

  return { shouldBluff, bluffType, bluffSizeMultiplier };
}

function evaluateBoardScareLevel(cc) {
  let scare = cc.filter((c) => c.value >= 11).length * 0.1;
  const vc = {};
  for (const c of cc) vc[c.value] = (vc[c.value] || 0) + 1;
  if (Object.values(vc).some((v) => v >= 2)) scare += 0.15;
  const sc = {};
  for (const c of cc) sc[c.suit] = (sc[c.suit] || 0) + 1;
  if (Object.values(sc).some((v) => v >= 3)) scare += 0.2;
  const sv = [...new Set(cc.map((c) => c.value))].sort((a, b) => a - b);
  for (let i = 0; i < sv.length - 1; i++) if (sv[i + 1] - sv[i] <= 2) scare += 0.05;
  return Math.min(1, scare);
}

function evaluateBlockers(holeCards, cc) {
  let bonus = 0;
  if (holeCards.some((c) => c.value === 14)) bonus += 0.05;
  const sc = {};
  for (const c of cc) sc[c.suit] = (sc[c.suit] || 0) + 1;
  for (const [suit, count] of Object.entries(sc)) {
    if (count >= 3 && holeCards.some((c) => c.suit === suit && c.value === 14)) bonus += 0.1;
  }
  return bonus;
}

// ============================================================
//  BET SIZING
// ============================================================

function calculateBetSize(equity, pot, chips, profile, context, opponentProfiles) {
  let sizingFactor;
  if (context === 'value') {
    let stationBonus = 0;
    if (opponentProfiles) {
      const stations = opponentProfiles.filter((p) => p.playerType === 'calling_station').length;
      stationBonus = stations * 0.15;
    }
    if (equity > 0.75) {
      switch (profile.style) {
        case 'tricky':
          sizingFactor = Math.random() < 0.4 ? 0.35 : 0.9;
          break;
        case 'maniac':
          sizingFactor = 1.0 + Math.random() * 0.5;
          break;
        case 'aggressive':
          sizingFactor = 0.7 + Math.random() * 0.5;
          break;
        default:
          sizingFactor = 0.55 + Math.random() * 0.35;
      }
      sizingFactor += stationBonus;
    } else if (equity > 0.55) {
      sizingFactor = 0.4 + Math.random() * 0.3 + stationBonus * 0.5;
    } else {
      sizingFactor = 0.25 + Math.random() * 0.25;
    }
  } else {
    sizingFactor = 0.5;
  }
  return Math.min(Math.max(Math.floor(pot * sizingFactor), 1), chips);
}

// ============================================================
//  MAIN DECISION ENGINE
// ============================================================

function buildSessionProfile(profile) {
  // Per-hand personality drift: ±15% random variation on key traits
  const drift = () => 0.85 + Math.random() * 0.3;
  return {
    ...profile,
    tightness: Math.max(0.05, Math.min(0.95, profile.tightness * drift())),
    bluffFreq: Math.max(0.02, Math.min(0.6, profile.bluffFreq * drift())),
    aggression: Math.max(0.1, Math.min(0.98, (profile.aggression || 0.5) * drift())),
    cbetFreq: Math.max(0.1, Math.min(0.95, (profile.cbetFreq || 0.5) * drift())),
    checkRaiseFreq: Math.max(0.01, Math.min(0.4, (profile.checkRaiseFreq || 0.1) * drift())),
  };
}

function npcDecision(profile, holeCards, communityCards, gameState) {
  const sessionProfile = buildSessionProfile(profile);

  // ══════════════════════════════════════════════════════
  //  v8: Psychology integration with EV-safety guardrails
  //  Core principle: MC equity is the floor, psychology
  //  only adjusts HOW decisions are expressed, never
  //  overrides clearly -EV decisions.
  //
  //  What psychology CAN do (EV-neutral or near-neutral):
  //    ✅ Change bet SIZING (bigger/smaller)
  //    ✅ Choose WHICH borderline hands to bluff with
  //    ✅ Slowplay very strong hands (>80% equity)
  //    ✅ Call slightly lighter when near break-even
  //    ✅ Shift preflop opening range in borderline spots
  //
  //  What psychology CANNOT do:
  //    ❌ Call when equity is clearly below pot odds
  //    ❌ Fold when equity is clearly above pot odds
  //    ❌ Bluff into spots where fold equity is near zero
  // ══════════════════════════════════════════════════════

  const psych = gameState.psychMods || {};

  // Psychology only nudges preflop ranges (small adjustment)
  if (psych.tightnessShift) {
    const cappedShift = Math.max(-0.08, Math.min(0.08, psych.tightnessShift));
    sessionProfile.tightness = Math.max(
      0.05,
      Math.min(0.95, sessionProfile.tightness + cappedShift)
    );
  }

  // Aggression affects bet sizing style, not fold/call decisions
  if (psych.aggressionShift) {
    sessionProfile.aggression = Math.max(
      0.1,
      Math.min(0.98, sessionProfile.aggression + psych.aggressionShift)
    );
  }

  // Bluff frequency only shifts within borderline spots (won't bluff with 0% fold equity)
  if (psych.bluffFreqShift) {
    const cappedBluff = Math.max(-0.1, Math.min(0.1, psych.bluffFreqShift));
    sessionProfile.bluffFreq = Math.max(
      0.02,
      Math.min(0.5, sessionProfile.bluffFreq + cappedBluff)
    );
  }

  // Bet size multiplier: psychology CAN make bets bigger/smaller (this is EV-adjusting, not EV-destroying)
  const psychBetMult = Math.max(0.7, Math.min(1.8, psych.betSizeMult || 1.0));

  // Trap: only with very strong hands (>80% equity) — giving up one street of value is acceptable
  const psychShouldTrap = psych.shouldTrap || false;

  // Overbet: only with strong hands (>55% equity) — polarized sizing is valid strategy
  const psychShouldOverbet = psych.shouldOverbet || false;

  // Call-down bonus: only allows calling when ALREADY near break-even (within 5% of pot odds)
  // This prevents "calling with garbage just because angry"
  const psychCallDownBonus = Math.min(0.05, psych.callDownShift || 0);

  const {
    pot,
    currentBet,
    playerBet,
    chips,
    minRaise,
    phase,
    activePlayers,
    seatIndex,
    dealerIndex,
    totalPlayers,
    opponentActions,
    opponentProfiles: oppProfs,
    preflopTable,
  } = gameState;
  const toCall = effectiveToCallAmount(currentBet, playerBet, chips);

  const positionFactor = getPositionFactor(seatIndex || 0, dealerIndex || 0, totalPlayers || 4);
  const posName = getPositionName(seatIndex || 0, dealerIndex || 0, totalPlayers || 4);
  gameState._positionName = posName;
  gameState._wasPreRaiser = gameState._wasPreRaiser || false;

  if (phase === 'preflop') {
    let strength;
    const opponents = Math.max(1, (activePlayers || 2) - 1);
    const tableEquity = preflopTable
      ? lookupPreflopEquity(preflopTable, holeCards, opponents)
      : null;

    if (tableEquity !== null) {
      const maxEq = [0, 0.85, 0.73, 0.64, 0.56, 0.5, 0.45, 0.41][Math.min(opponents, 7)];
      const minEq = [0, 0.31, 0.2, 0.14, 0.11, 0.09, 0.07, 0.06][Math.min(opponents, 7)];
      const range = maxEq - minEq || 1;
      strength = 0.28 + Math.max(0, (tableEquity - minEq) / range) * 0.72;
      strength = Math.min(1, Math.max(0, strength));
    } else {
      strength = evaluatePreflop(holeCards);
    }

    // Chart-based range check: should we even be in this hand?
    const bb = gameState.bigBlind || 20;
    const rawToCall = Math.max(0, currentBet - playerBet);
    const scenario =
      rawToCall > bb ? (rawToCall > bb * 6 ? 'facing_3bet' : 'facing_raise') : 'open';
    const tightnessAdj = (sessionProfile.tightness - 0.5) * 4; // map 0-1 to -2..+2
    const chartDecision = chartBasedPreflopDecision(holeCards, posName, scenario, tightnessAdj);

    const exploitDefense = headsUpPreflopDefenseDecision(
      sessionProfile,
      strength,
      posName,
      gameState,
      holeCards
    );
    if (exploitDefense) return exploitDefense;

    // If chart says fold AND equity-based strength is below threshold, fold
    // This prevents entering pots with hands outside our positional range
    if (chartDecision.action === 'fold' && strength < 0.6) {
      // Allow small chance to deviate (personality-driven)
      if (Math.random() > sessionProfile.bluffFreq * 0.5) {
        return { action: toCall > 0 ? 'fold' : 'check' };
      }
    }

    return preflopDecision(sessionProfile, strength, positionFactor, posName, gameState);
  }

  if (!gameState?._skipSolverFastPath) {
    const solverAction = trySolverDecision(
      profile,
      sessionProfile,
      holeCards,
      communityCards,
      gameState
    );
    if (solverAction) return solverAction;
  }

  const excludeCards = [...holeCards, ...communityCards];
  const opponentRanges = [];
  const opponentProfileList = [];

  if (opponentActions && oppProfs) {
    for (const [oppId, actions] of Object.entries(opponentActions)) {
      const oppProfile = oppProfs[oppId] || null;
      const range = estimateRange(excludeCards, oppProfile, actions, communityCards, {
        bigBlind: gameState.bigBlind || 20,
      });
      if (range.length > 0) {
        opponentRanges.push(range);
        if (oppProfile) opponentProfileList.push(oppProfile);
      }
    }
  }

  let mcResult;
  if (opponentRanges.length > 0) {
    mcResult = rangeWeightedMC(holeCards, communityCards, opponentRanges, MC_SIMULATIONS);
  } else {
    mcResult = vanillaMC(holeCards, communityCards, Math.max(1, activePlayers - 1), MC_SIMULATIONS);
  }

  const equity = mcResult.equity;
  const drawInfo = calculateOuts(holeCards, communityCards);
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

  // ── Strategy layer: board texture + hand plan + SPR ──
  gameState._positionName = posName;
  const strat = generateStrategy(holeCards, communityCards, gameState);

  // ── Veteran thinking layer ──
  const vetRead = generateVeteranRead(gameState, sessionProfile, phase);
  const vetAdj = applyVeteranRead(vetRead, equity, toCall, pot, chips, minRaise, sessionProfile);

  const bluffInfo = evaluateBluff(
    sessionProfile,
    holeCards,
    communityCards,
    gameState,
    drawInfo,
    opponentProfileList
  );

  // ══════════════════════════════════════════════════════
  //  UNIFIED MODIFIER CONSOLIDATION
  //  All adjustments computed here, applied once, no stacking
  //
  //  Architecture:
  //    Layer 1 (Perception): equity, potOdds, drawInfo — IMMUTABLE
  //    Layer 2 (Reasoning):  ONE equity adjustment, ONE fold threshold
  //    Layer 3 (Expression): ONE bet size multiplier, bluff/trap decisions
  // ══════════════════════════════════════════════════════

  // ── Layer 2: Single equity adjustment (noise only, no system biases equity) ──
  // MC equity is objective truth. No system should inflate or deflate it.
  // The only adjustment is small noise for unpredictability.
  const noise = (Math.random() - 0.5) * 0.04;
  const effectiveEquity = Math.max(0, Math.min(1, equity + noise));

  // ── Layer 2: Single fold threshold ──
  // Base: personality × position. Psychology can relax it slightly (max 5%).
  // Hard floor: never call when equity < 85% of pot odds.
  const baseFoldThreshold = Math.max(0.05, (sessionProfile.tightness * 0.35) / positionFactor);
  const foldThreshold = Math.max(
    potOdds * 0.85, // Hard floor: pot odds safety
    baseFoldThreshold - Math.min(0.05, psychCallDownBonus) // Psychology relaxation capped at 5%
  );

  // ── Layer 3: Single bet size multiplier ──
  // Combine veteran + psychology, but CAP the total to prevent absurd bets.
  // Range: 0.6x to 1.6x of calculated bet size.
  const rawSizeMult = (vetAdj.betSizeMultiplier || 1.0) * psychBetMult;
  const sizeMult = Math.max(0.6, Math.min(1.6, rawSizeMult));
  const planSize = Math.max(minRaise, Math.floor(strat.planBetSize * sizeMult));

  // ═══ RIVER POLARIZATION ═══
  // On the river, use GTO-inspired polarized strategy
  if (phase === 'river') {
    const riverDecision = riverPolarizedDecision(
      effectiveEquity,
      pot,
      chips,
      toCall,
      minRaise,
      strat.boardTex,
      sessionProfile
    );

    if (toCall === 0) {
      // Not facing a bet
      if (riverDecision.shouldBet && riverDecision.betSize > 0 && chips > riverDecision.betSize) {
        return { action: 'raise', amount: Math.floor(riverDecision.betSize * sizeMult) };
      }
      // Bluff commitment override (already started bluffing earlier streets)
      if (vetAdj.shouldBluffContinue && effectiveEquity < 0.25) {
        const s = Math.max(minRaise, vetAdj.bluffContinueSize);
        if (chips > s) return { action: 'raise', amount: Math.floor(s * sizeMult) };
      }
      return { action: 'check' };
    } else {
      // Facing a bet on river — apply golden rule
      const riverBetRatio = toCall / Math.max(1, pot - toCall);
      let riverOverbetPenalty = 0;
      if (riverBetRatio > 2.0) riverOverbetPenalty = 0.15;
      else if (riverBetRatio > 1.5) riverOverbetPenalty = 0.1;
      else if (riverBetRatio > 1.0) riverOverbetPenalty = 0.05;
      const riverAdjEq = effectiveEquity - riverOverbetPenalty;
      const riverCanContinue = riverAdjEq >= potOdds || riverAdjEq >= 0.8;

      if (!riverCanContinue) return { action: 'fold' };

      // We can profitably continue — decide how
      if (riverDecision.shouldBet && riverDecision.betSize > 0 && chips > riverDecision.betSize) {
        return {
          action: 'raise',
          amount: Math.min(Math.floor(riverDecision.betSize * sizeMult), chips),
        };
      }
      return { action: 'call' };
    }
  }

  // ═══ NOT FACING A BET ═══
  if (toCall === 0) {
    // v8: Psychology trap — ONLY with very strong hands (>80% equity)
    // Giving up one street of value is acceptable when you're a massive favorite
    if (psychShouldTrap && effectiveEquity > 0.8) {
      return { action: 'check' }; // 设陷阱: 极强牌故意示弱
    }
    // v8: Psychology overbet — ONLY with strong hands (>55% equity)
    // Polarized sizing is a valid strategy, not an emotional mistake
    if (psychShouldOverbet && effectiveEquity > 0.55 && chips > pot * 2) {
      const overbetSize = Math.floor(pot * (1.5 + Math.random()) * psychBetMult);
      return { action: 'raise', amount: Math.min(overbetSize, chips) };
    }
    // Bluff commitment
    if (vetAdj.shouldBluffContinue && effectiveEquity < 0.25) {
      const s = Math.max(minRaise, vetAdj.bluffContinueSize);
      if (chips > s) return { action: 'raise', amount: Math.floor(s * sizeMult) };
    }
    // Monster slowplay
    if (strat.plan.shouldSlowplay && strat.plan.planType === 'monster') {
      return { action: 'check' };
    }
    // Plan says bet this street
    if (strat.shouldBetThisStreet && effectiveEquity > 0.45 && chips > planSize) {
      return { action: 'raise', amount: Math.floor(planSize * psychBetMult) };
    }
    // C-bet by board texture
    if (gameState._wasPreRaiser && phase === 'flop' && Math.random() < sessionProfile.cbetFreq) {
      const sz = Math.max(
        minRaise,
        Math.floor(pot * (strat.boardTex.texture === 'wet' ? 0.67 : 0.33))
      );
      if (chips > sz) return { action: 'raise', amount: Math.floor(sz * sizeMult) };
    }
    // Strong equity value bet
    if (effectiveEquity > 0.6 && chips > planSize) {
      return { action: 'raise', amount: Math.floor(planSize * psychBetMult) };
    }
    // Semi-bluff draws
    if (
      (strat.plan.drawPlan === 'semi_bluff' || strat.plan.drawPlan === 'aggressive_draw') &&
      drawInfo.outs >= 6 &&
      (posName === 'late' || posName === 'dealer')
    ) {
      const sz = Math.max(minRaise, Math.floor(pot * 0.6));
      if (chips > sz) return { action: 'raise', amount: sz };
    }
    // Blocker bluff
    if (bluffInfo.shouldBluff && strat.blockerValue > 0.2 && chips > pot * 0.4) {
      const sz = Math.max(minRaise, Math.floor(pot * (0.6 + strat.blockerValue * 0.3)));
      if (chips > sz) return { action: 'raise', amount: Math.floor(sz * sizeMult) };
    }
    // Regular bluff
    if (bluffInfo.shouldBluff && chips > pot * 0.4) {
      const sz = Math.max(minRaise, Math.floor(pot * bluffInfo.bluffSizeMultiplier));
      if (chips > sz) return { action: 'raise', amount: Math.floor(sz * sizeMult) };
    }
    // Probe
    if (effectiveEquity > 0.35 && Math.random() < sessionProfile.aggression * 0.25) {
      const sz = Math.max(
        minRaise,
        Math.floor(pot * (strat.boardTex.texture === 'dry' ? 0.25 : 0.45))
      );
      if (chips > sz) return { action: 'raise', amount: sz };
    }
    return { action: 'check' };
  }

  // ═══ FACING A BET (Flop / Turn) ═══
  //
  // ┌─────────────────────────────────────────────────────────┐
  // │  THE GOLDEN RULE: Every call/raise must satisfy EITHER: │
  // │  (A) adjEquity >= potOdds  (mathematically profitable)  │
  // │  (B) adjEquity >= 0.80     (monster hand, always play)  │
  // │  One exception: strong draw + cheap price (implied odds)│
  // │  No catch-alls. No "cheap call" bypasses. No overrides. │
  // └─────────────────────────────────────────────────────────┘

  // Step 1: Overbet penalty (opponent's large bet signals strength)
  const betToPotRatio = toCall / Math.max(1, pot - toCall);
  let overbetPenalty = 0;
  if (betToPotRatio > 2.0) overbetPenalty = 0.15;
  else if (betToPotRatio > 1.5) overbetPenalty = 0.1;
  else if (betToPotRatio > 1.0) overbetPenalty = 0.05;
  const adjEquity = effectiveEquity - overbetPenalty;

  // Step 2: Can we profitably continue?
  const canContinue = adjEquity >= potOdds || adjEquity >= 0.8;

  // Step 3: If not profitable, only exception is strong draw at cheap price
  if (!canContinue) {
    if (drawInfo.outs >= 8 && toCall < chips * 0.1 && toCall < pot * 0.5) {
      return { action: 'call' }; // Implied odds: strong draw, cheap price
    }
    return { action: 'fold' };
  }

  // ── From here, calling is at least break-even. Decide HOW to continue. ──

  // Monster: check-raise or raise for max value
  if (adjEquity >= 0.8) {
    if (strat.plan.shouldCheckRaise && strat.plan.planType === 'monster') {
      const sz = Math.max(minRaise, Math.floor(pot * (0.8 + sessionProfile.aggression * 0.4)));
      return { action: 'raise', amount: Math.min(sz, chips) };
    }
    if (strat.spr < 4 && overbetPenalty === 0) {
      return { action: 'allin' };
    }
    const amt = Math.max(minRaise, Math.floor(planSize * 1.3));
    if (amt > toCall && chips > amt) return { action: 'raise', amount: amt };
    return { action: 'call' };
  }

  // Very strong: raise or call
  if (adjEquity > 0.7) {
    if (sessionProfile.style === 'tricky' && Math.random() < 0.3) return { action: 'call' };
    if (Math.random() < sessionProfile.checkRaiseFreq) {
      const sz = Math.max(minRaise, Math.floor(pot * 0.8));
      return { action: 'raise', amount: Math.min(sz, chips) };
    }
    return { action: 'call' };
  }

  // Good hand: call, aggressive players sometimes raise
  if (adjEquity > 0.55) {
    if (
      (sessionProfile.style === 'aggressive' || sessionProfile.style === 'maniac') &&
      Math.random() < 0.25
    ) {
      if (chips > planSize && planSize > toCall) return { action: 'raise', amount: planSize };
    }
    return { action: 'call' };
  }

  // Marginal with draw: semi-bluff raise opportunity
  if (drawInfo.outs >= 9 && bluffInfo.shouldBluff && chips > toCall * 3) {
    const amt = Math.max(minRaise, Math.floor(pot * 0.6));
    if (chips > amt) return { action: 'raise', amount: amt };
  }

  // Marginal: just call (guaranteed profitable by Step 2)
  return { action: 'call' };
}

// ============================================================
//  PREFLOP DECISION
// ============================================================

function preflopDecision(profile, strength, posFactor, posName, gs) {
  const { currentBet, playerBet, chips, minRaise, activePlayers } = gs;
  const toCall = effectiveToCallAmount(currentBet, playerBet, chips);
  const bb = gs.bigBlind || 20;
  const openThreshold = (profile.tightness * 0.5) / posFactor;

  if (strength > 0.85) {
    const size =
      currentBet > bb
        ? Math.floor(currentBet * (2.5 + Math.random()))
        : Math.floor(bb * (2.5 + Math.random() * 1.5));
    gs._wasPreRaiser = true;
    return { action: 'raise', amount: Math.min(Math.max(minRaise, size), chips) };
  }
  if (strength > 0.65) {
    if (toCall <= bb) {
      gs._wasPreRaiser = true;
      return {
        action: 'raise',
        amount: Math.min(Math.max(minRaise, Math.floor(bb * (2.2 + Math.random()))), chips),
      };
    }
    if (toCall <= bb * 4) {
      if (posName === 'early' && profile.tightness > 0.5 && Math.random() < 0.3)
        return { action: 'fold' };
      return { action: 'call' };
    }
    if (strength > 0.75) return { action: 'call' };
    return { action: 'fold' };
  }
  if (strength > openThreshold) {
    if (toCall <= bb) {
      if (posName === 'late' || posName === 'dealer') {
        gs._wasPreRaiser = true;
        return {
          action: 'raise',
          amount: Math.min(Math.max(minRaise, Math.floor(bb * (2 + Math.random()))), chips),
        };
      }
      if (posName === 'middle') {
        if (Math.random() < 0.5) return { action: 'call' };
        gs._wasPreRaiser = true;
        return {
          action: 'raise',
          amount: Math.min(Math.max(minRaise, Math.floor(bb * (2 + Math.random()))), chips),
        };
      }
      if (Math.random() < profile.tightness) return { action: 'fold' };
      return { action: 'call' };
    }
    if (toCall <= bb * 3 && (posName === 'late' || posName === 'dealer')) return { action: 'call' };
    return { action: 'fold' };
  }
  if (
    (posName === 'dealer' || posName === 'late') &&
    toCall <= bb &&
    activePlayers <= 3 &&
    Math.random() < 0.3
  ) {
    gs._wasPreRaiser = true;
    return {
      action: 'raise',
      amount: Math.min(Math.max(minRaise, Math.floor(bb * (2 + Math.random()))), chips),
    };
  }
  if (toCall === 0) return { action: 'check' };
  return { action: 'fold' };
}

// ============================================================
//  EXPORTS
// ============================================================

function getAvailableNPCs(count) {
  // 跨作品均匀选角：同一来源最多出场2个
  const shuffled = [...NPC_PROFILES];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // 第一轮：每个来源最多1个
  const selected = [];
  const originCount = {};
  for (const npc of shuffled) {
    if (selected.length >= count) break;
    const origin = npc.origin || '未知';
    if (!originCount[origin]) originCount[origin] = 0;
    if (originCount[origin] < 1) {
      selected.push(npc);
      originCount[origin]++;
    }
  }

  // 不够的话第二轮：允许每个来源第2个
  if (selected.length < count) {
    const selectedNames = new Set(selected.map((n) => n.name));
    for (const npc of shuffled) {
      if (selected.length >= count) break;
      if (selectedNames.has(npc.name)) continue;
      const origin = npc.origin || '未知';
      if (originCount[origin] < 2) {
        selected.push(npc);
        originCount[origin]++;
        selectedNames.add(npc.name);
      }
    }
  }

  return selected;
}

function getNPCByName(name) {
  return NPC_PROFILES.find((p) => p.name === name) || null;
}

function getHandStrength(holeCards, communityCards) {
  if (communityCards.length === 0) return evaluatePreflop(holeCards);
  return vanillaMC(holeCards, communityCards, 2, MC_SIMULATIONS).equity;
}

function trySolverDecision(profile, sessionProfile, holeCards, communityCards, gameState) {
  if (!gameState) return null;

  const setTrace = (status, reason, extra = {}) => {
    gameState._solverTrace = {
      status,
      npcName: profile?.name || null,
      ...(gameState.solverContext
        ? {
          positionPair: gameState.solverContext.positionPair,
          preflopLine: gameState.solverContext.preflopLine,
          actionLine: gameState.solverContext.actionLine || 'root',
          effectiveBB: gameState.solverContext.effectiveBB,
          takeoverMode: gameState.solverContext.takeoverMode,
          takeoverReason: gameState.solverContext.takeoverReason,
        }
      : {}),
      ...extra,
      classification: extra.classification || null,
      reason,
    };
  };

  if (!isSolverEligibleProfile(profile)) {
    setTrace('fallback', 'npc_not_solver_enabled');
    return null;
  }
  if (!gameState?.solverContext?.supported) {
    setTrace('fallback', gameState?.solverContext?.reason || 'unsupported_context');
    return null;
  }
  if ((communityCards || []).length < 3) {
    setTrace('fallback', 'board_too_short');
    return null;
  }

  const lookup = lookupStrategyDetailed({
    solverContext: gameState.solverContext,
    holeCards,
    dataDir: gameState.solverDataDir,
    rootCacheDir: gameState.solverRootCacheDir,
  });
  if (!lookup.strategy) {
    setTrace('fallback', lookup.meta?.reason || 'lookup_miss', lookup.meta || {});
    return null;
  }

  const deviated = applyPersonaDeviation(lookup.strategy, profile, gameState.psychMods || {});
  if (!deviated) {
    setTrace('fallback', 'persona_deviation_empty', lookup.meta || {});
    return null;
  }

  const decision = solverDecisionFromStrategy(
    deviated,
    gameState,
    () => Math.random()
  );
  if (!decision) {
    setTrace('fallback', 'translation_failed', lookup.meta || {});
    return null;
  }

  if (decision.action === 'raise' && sessionProfile?.aggression) {
    const jitter = 1 + (Math.random() - 0.5) * Math.min(0.16, sessionProfile.aggression * 0.12);
    const maxTotal = gameState.playerBet + gameState.chips;
    const target = Math.floor(decision.amount * jitter);
    const clamped = Math.max(gameState.minRaise, Math.min(target, maxTotal));
    const resolved =
      clamped >= maxTotal
        ? { action: 'allin', _solver: true }
        : { action: 'raise', amount: clamped, _solver: true };
    setTrace('hit', 'solver_strategy_applied', {
      ...(lookup.meta || {}),
      action: resolved.action,
      amount: resolved.amount || 0,
    });
    return resolved;
  }

  const resolved = { ...decision, _solver: true };
  setTrace('hit', 'solver_strategy_applied', {
    ...(lookup.meta || {}),
    action: resolved.action,
    amount: resolved.amount || 0,
  });
  return resolved;
}

function localFallbackDecision(profile, holeCards, communityCards, gameState) {
  return npcDecision(profile, holeCards, communityCards, {
    ...(gameState || {}),
    _skipSolverFastPath: true,
  });
}

module.exports = {
  npcDecision,
  getAvailableNPCs,
  getNPCByName,
  NPC_PROFILES,
  getHandStrength,
  rangeWeightedMC,
  vanillaMC,
  MC_SIMULATIONS,
  buildSessionProfile,
  localFallbackDecision,
  trySolverDecision,
  effectiveToCallAmount,
  headsUpPreflopDefenseDecision,
};
