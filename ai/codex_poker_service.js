const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_PORT = 8911;
const DEFAULT_TIMEOUT_MS = 90000;
const ACTIONS = new Set(['fold', 'check', 'call', 'raise', 'allin']);
const SCHEMA_PATH = path.join(__dirname, 'codex_poker_action.schema.json');

function boolFromEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function intFromEnv(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeAction(action) {
  const normalized = String(action || '').trim().toLowerCase();
  if (normalized === 'all-in' || normalized === 'all_in') return 'allin';
  return ACTIONS.has(normalized) ? normalized : null;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatAmount(value) {
  const number = safeNumber(value, 0);
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
}

function legalActionText(payload) {
  const actions = payload.legalActions || [];
  if (actions.length > 0) return actions.join(', ');

  const toCall = safeNumber(payload.toCallBb, 0);
  if (toCall > 0) return 'fold, call, raise, allin';
  return 'check, raise, allin';
}

function buildCodexPrompt(payload) {
  const lines = [];
  lines.push('You are deciding one heads-up no-limit Texas hold’em action for a local practice game.');
  lines.push('Do not run commands, inspect files, or explain. Use only the poker situation below.');
  lines.push('Return only JSON that matches the provided schema.');
  lines.push('');
  lines.push('Decision rules:');
  lines.push('- Choose exactly one legal action.');
  lines.push('- If facing a bet, check is illegal. If not facing a bet, fold is illegal.');
  lines.push('- If raising, amountBb is the final total bet size in big blinds, not the extra amount.');
  lines.push('- If not raising, amountBb must be null.');
  lines.push('- Prefer solid heads-up strategy over personality flavor.');
  lines.push('');
  lines.push('Situation:');
  lines.push(`- Street: ${payload.street}`);
  lines.push(`- Hero position: ${payload.heroPosition}`);
  lines.push(`- Hero cards: ${(payload.heroHoleCards || []).join(' ')}`);
  lines.push(`- Board: ${(payload.boardCards || []).join(' ') || 'none'}`);
  lines.push(`- Pot: ${formatAmount(payload.potBb)} BB`);
  lines.push(`- Hero stack: ${formatAmount(payload.heroStackBb)} BB`);
  lines.push(`- Villain stack: ${formatAmount(payload.villainStackBb)} BB`);
  lines.push(`- Current bet: ${formatAmount(payload.currentBetBb)} BB`);
  lines.push(`- Hero already bet: ${formatAmount(payload.playerBetBb)} BB`);
  lines.push(`- To call: ${formatAmount(payload.toCallBb)} BB`);
  lines.push(`- Minimum raise-to: ${formatAmount(payload.minRaiseToBb)} BB`);
  lines.push(`- Maximum raise-to: ${formatAmount(payload.maxRaiseToBb)} BB`);
  lines.push(`- Legal actions: ${legalActionText(payload)}`);

  const history = payload.actionHistoryText || [];
  if (history.length > 0) {
    lines.push('');
    lines.push('Action history:');
    for (const item of history) lines.push(`- ${item}`);
  }

  const persona = payload.persona || {};
  if (persona.name || persona.style) {
    lines.push('');
    lines.push(`NPC profile: ${persona.name || 'NPC'}; style: ${persona.style || 'balanced'}.`);
  }

  lines.push('');
  lines.push('Output example: {"action":"call","amountBb":null}');
  return lines.join('\n');
}

function parseCodexDecision(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || '').trim());
  } catch (error) {
    const match = String(raw || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('codex_output_missing_json');
    parsed = JSON.parse(match[0]);
  }

  const action = normalizeAction(parsed.action);
  if (!action) throw new Error('codex_invalid_action');
  const amountBb =
    parsed.amountBb === null || parsed.amountBb === undefined ? null : safeNumber(parsed.amountBb, NaN);
  if (amountBb !== null && !Number.isFinite(amountBb)) {
    throw new Error('codex_invalid_amount');
  }
  return { action, amountBb };
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '')}"`;
}

function cmdArg(value) {
  const raw = String(value);
  return /\s/.test(raw) ? quoteCmdArg(raw) : raw;
}

function spawnCodexProcess(codexBin, args, options) {
  if (process.platform === 'win32') {
    const resolvedBin = !codexBin || codexBin === 'codex' ? 'codex.cmd' : codexBin;
    const commandName = /[\\/\s]/.test(resolvedBin) ? quoteCmdArg(resolvedBin) : resolvedBin;
    const command = [commandName, ...args.map(cmdArg)].join(' ');
    return spawn('cmd.exe', ['/d', '/s', '/c', command], options);
  }
  return spawn(codexBin || 'codex', args, options);
}

function runCodexExec({ prompt, timeoutMs, model, codexBin, cwd }) {
  return new Promise((resolve, reject) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lonicera-codex-poker-'));
    const outputPath = path.join(tempDir, 'decision.json');
    const args = [];
    if (model) {
      args.push('--model', model);
    }
    args.push(
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--output-schema',
      SCHEMA_PATH,
      '-o',
      outputPath,
      '-'
    );

    const child = spawnCodexProcess(codexBin, args, {
      cwd: cwd || process.cwd(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('codex_timeout'));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (code !== 0) {
          throw new Error(`codex_exit_${code}`);
        }
        const raw = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : stdout;
        resolve(parseCodexDecision(raw));
      } catch (error) {
        reject(error);
      } finally {
        fs.rm(tempDir, { recursive: true, force: true }, () => {});
      }
    });

    child.stdin.end(prompt);
  });
}

async function decide(payload, options = {}) {
  const startedAt = Date.now();
  if (options.dryRun) {
    const action = safeNumber(payload.toCallBb, 0) > 0 ? 'call' : 'check';
    return {
      ok: true,
      action,
      amountBb: null,
      modelVersion: 'codex-cli-dry-run',
      latencyMs: Date.now() - startedAt,
    };
  }

  const prompt = buildCodexPrompt(payload);
  const result = await runCodexExec({
    prompt,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    model: options.model || '',
    codexBin: options.codexBin || 'codex',
    cwd: options.cwd || process.cwd(),
  });
  return {
    ok: true,
    ...result,
    modelVersion: options.model || 'codex-cli',
    latencyMs: Date.now() - startedAt,
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 1_000_000) {
        request.destroy(new Error('request_too_large'));
      }
    });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('invalid_json'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function createServer(options = {}) {
  return http.createServer(async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    if (request.url === '/health') {
      sendJson(response, 200, { ok: true, status: 'online', backend: 'codex-cli' });
      return;
    }

    if (request.url !== '/decide') {
      sendJson(response, 404, { ok: false, error: 'not_found' });
      return;
    }

    try {
      const payload = await readJsonBody(request);
      const result = await decide(payload, options);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: 'decision_failed',
      });
    }
  });
}

function main() {
  const options = {
    timeoutMs: intFromEnv('CODEX_POKER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1000, 300000),
    model: process.env.CODEX_POKER_MODEL || '',
    codexBin: process.env.CODEX_BIN || 'codex',
    cwd: process.env.CODEX_POKER_CWD || process.cwd(),
    dryRun: boolFromEnv('CODEX_POKER_DRY_RUN', false),
  };
  const host = process.env.CODEX_POKER_HOST || '127.0.0.1';
  const port = intFromEnv('CODEX_POKER_PORT', DEFAULT_PORT, 1, 65535);
  const server = createServer(options);
  server.listen(port, host, () => {
    const ready = {
      ok: true,
      host,
      port,
      backend: 'codex-cli',
      model: options.model || 'default',
      dryRun: options.dryRun,
    };
    console.log(JSON.stringify(ready));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildCodexPrompt,
  createServer,
  decide,
  normalizeAction,
  parseCodexDecision,
  runCodexExec,
};
