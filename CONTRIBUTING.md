# Contributing to LONICERA: A Poker Game

Thanks for your interest! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/Evostructs/LONICERA.git
cd lonicera
npm install
npm start
```

Open `http://localhost:2026`. Changes to files take effect after restarting the server.

## Running Tests

```bash
npm test
npm run lint
npm run format:check
```

All checks must pass before submitting a PR.

## Project Structure

- **Backend logic**: `engine.js`, `npc.js`, `strategy.js`, `veteran.js` — game engine and AI
- **Server & networking**: `server.js`, `server/` — Express, Socket.IO, host rules, middleware
- **Frontend**: `public/index.html`, `public/css/`, `public/js/`
- **Tests**: `__tests__/`

## Pull Request Guidelines

1. One feature or fix per PR
2. Add tests for new game logic
3. Preserve self-hosted deployment assumptions: do not force HTTPS in a way that breaks NAS/LAN HTTP setups
4. NPC names stay in Chinese with English subtitles; all UI text in English
5. Code comments in English
6. Run `npm test`, `npm run lint`, and `npm run format:check` before submitting

## Adding a New NPC

1. Add a profile object to `NPC_PROFILES` in `npc.js`
2. Set `origin` to the literary/historical source
3. The selection algorithm (`getAvailableNPCs`) limits 2 NPCs per origin per table

## Reporting Bugs

Open an issue with:

- Steps to reproduce
- Expected vs actual behavior
- Browser and device info
- Docker logs if applicable (`docker logs lonicera`)
- Whether the deployment is local Node, Docker, reverse proxy, or NAS
