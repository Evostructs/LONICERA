# LONICERA: A Poker Game — Development Story

> **Timeline:** March — April 2026  
> **Stack:** Node.js + Express + Socket.IO + Vanilla JS  
> **Built by:** Evostructs × Claude

---

## The Evolution

A home poker game that grew into a full AI platform across 11 internal iterations over two weeks.

| Phase | What Happened                                                                    |
| ----- | -------------------------------------------------------------------------------- |
| v1-v3 | Core engine, hand evaluation, basic NPC, poker table UI                          |
| v4-v5 | Opponent modeling, range estimation, preflop lookup table (169 types × 10K sims) |
| v6-v7 | Post-flop strategy engine, multi-street planning, veteran reasoning              |
| v8    | Psychology system (tilt, revenge, confidence), NPC chat, roster expanded to 16   |
| v9    | Neural network experiment — NFSP 5M hands trained, deployed, tested              |
| v10   | Neural network pulled offline — too weak, rule engine proved stronger            |
| v11   | Three game modes, equity oracle, practice mode, open-source prep                 |

---

## Key Technical Decisions

**Range-weighted Monte Carlo over vanilla MC.** Naive MC assumes opponents hold random cards. Our equity calculator observes opponent actions (raise/call/check), estimates their hand range, then samples from that range. Result: significantly more accurate equity in contested pots.

**Neural network trained, deployed, then disabled.** NFSP with 5M iterations produced a model that check/called 52% of the time and couldn't distinguish between calling a min-bet and calling an all-in. The rule engine with opponent modeling, psychology, and strategic planning outperformed it. The neural network module is preserved in `docs/experimental/` — awaiting a stronger training approach.

**Psychology makes NPCs feel human.** Pure game theory produces optimal but robotic opponents. The psychology layer adds tilt after bad beats, revenge targeting, confidence streaks, and gear-shifting — making each NPC feel like a distinct personality rather than a math function with a skin.

**GPL-3.0 with anti-gambling clause.** Not MIT — deliberate choice. Derivative works must keep the same source-available/copyleft terms, and real-money gambling use automatically terminates the license. Because the extra restriction is intentional, this is not plain OSI-approved GPL-3.0-only.

---

## Architecture

```
Preflop Lookup Table ──→ Position ──→ Personality ──→ Psychology
                              ↓
Post-flop Board ──→ Strategy Engine ──→ Action Plan ──→ MC Validation
                              ↓
Opponent Actions ──→ Range Estimation ──→ Range-Weighted MC ──→ Veteran Logic
                              ↓
                        Final Decision ──→ Chat Message
```

### 22 NPC Characters

| Origin                        | Characters                                                |
| ----------------------------- | --------------------------------------------------------- |
| Journey to the West           | Sun Wukong, Tang Seng                                     |
| Romance of the Three Kingdoms | Cao Cao, Zhuge Liang, Guan Yu, Zhao Yun, Zhang Fei        |
| Water Margin                  | Lin Chong, Wu Yong, Lu Zhishen                            |
| Dream of the Red Chamber      | Jia Baoyu, Wang Xifeng                                    |
| Shakespeare                   | Hamlet, Macbeth                                           |
| Homer's Epics                 | Odysseus, Achilles                                        |
| Chu-Han Contention            | Xiang Yu, Liu Bang, Han Xin, Zhang Liang, Fan Zeng, Yu Ji |

Each character has calibrated parameters for tightness, aggression, bluff frequency, c-bet tendency, and check-raise inclination. Maximum 2 characters from the same origin per table.

---

## Deployment

```bash
docker run -d -p 2026:2026 --restart unless-stopped --name lonicera ghcr.io/evostructs/lonicera:latest
```

Open `http://localhost:2026`. That's it.
