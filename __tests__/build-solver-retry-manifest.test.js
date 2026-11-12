const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function createFakeSolverDir(rootDir) {
  const solverDir = path.join(rootDir, 'solver');
  const rangeDir = path.join(solverDir, 'ranges', '6max_range', 'BTN', '2.5bb', 'BB', 'Call');
  fs.mkdirSync(rangeDir, { recursive: true });
  fs.writeFileSync(path.join(rangeDir, 'BTN_range.txt'), 'AA:1.0');
  fs.writeFileSync(path.join(rangeDir, 'BB_range.txt'), 'KK:1.0');
  return solverDir;
}

describe('build solver retry manifest script', () => {
  test('rebuilds retry scripts from ETIMEDOUT failures with recovery profile', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solver-retry-manifest-'));
    const reportDir = path.join(tmpDir, 'reports');
    const outputDir = path.join(tmpDir, 'retry-scripts');
    const manifestPath = path.join(tmpDir, 'retry-manifest.json');
    const solverDir = createFakeSolverDir(tmpDir);

    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, 'part-001.report.json'),
      JSON.stringify(
        {
          failures: [
            {
              inputScript:
                '/path/to/lonicera/.phase1-btn-vs-bb-srp-50bb-full/scripts/BTN_vs_BB__SRP__50bb__As7h2d.txt',
              rawOutputPath: '/tmp/flop_As7h2d.json',
              error: 'spawn /console_solver ETIMEDOUT',
            },
            {
              inputScript:
                '/path/to/lonicera/.phase1-btn-vs-bb-srp-50bb-full/scripts/BTN_vs_BB__SRP__50bb__Ks7h2d.txt',
              rawOutputPath: '/tmp/flop_Ks7h2d.json',
              error: 'spawn /console_solver ETIMEDOUT',
            },
            {
              inputScript:
                '/path/to/lonicera/.phase1-btn-vs-bb-srp-50bb-full/scripts/BTN_vs_BB__SRP__50bb__Qs7h2d.txt',
              rawOutputPath: '/tmp/flop_Qs7h2d.json',
              error: 'other failure',
            },
          ],
        },
        null,
        2
      )
    );

    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'build-solver-retry-manifest.js'),
        '--report-dir',
        reportDir,
        '--solver-dir',
        solverDir,
        '--output-dir',
        outputDir,
        '--manifest',
        manifestPath,
        '--tree-profile',
        'recovery',
        '--error-pattern',
        'ETIMEDOUT',
      ],
      { cwd: process.cwd(), stdio: 'pipe' }
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest).toHaveLength(2);

    const scriptText = fs.readFileSync(manifest[0].inputScript, 'utf8');
    expect(scriptText).toContain('set_bet_sizes oop,flop,bet,50,100');
    expect(scriptText).toContain('set_bet_sizes oop,turn,bet,66,125');
  });

  test('defaults retry manifest generation to adaptive profiles', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solver-retry-manifest-adaptive-'));
    const reportDir = path.join(tmpDir, 'reports');
    const outputDir = path.join(tmpDir, 'retry-scripts');
    const manifestPath = path.join(tmpDir, 'retry-manifest.json');
    const solverDir = createFakeSolverDir(tmpDir);

    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, 'part-001.report.json'),
      JSON.stringify(
        {
          failures: [
            {
              inputScript:
                '/path/to/lonicera/.phase1-btn-vs-bb-srp-50bb-full/scripts/BTN_vs_BB__SRP__50bb__As7h2d.txt',
              rawOutputPath: '/tmp/flop_As7h2d.json',
              error: 'Solver did not produce /tmp/flop_As7h2d.json',
            },
            {
              inputScript:
                '/path/to/lonicera/.phase1-btn-vs-bb-srp-50bb-full/scripts/BTN_vs_BB__SRP__50bb__6s5h4d.txt',
              rawOutputPath: '/tmp/flop_6s5h4d.json',
              error: 'Solver did not produce /tmp/flop_6s5h4d.json',
            },
            {
              inputScript: '/path/to/scripts/BTN_vs_BB__SRP__50bb__Ts9h7d.txt',
              rawOutputPath: '/tmp/flop_Ts9h7d.json',
              error: 'Solver did not produce /tmp/flop_Ts9h7d.json',
            },
          ],
        },
        null,
        2
      )
    );

    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'build-solver-retry-manifest.js'),
        '--report-dir',
        reportDir,
        '--solver-dir',
        solverDir,
        '--output-dir',
        outputDir,
        '--manifest',
        manifestPath,
      ],
      { cwd: process.cwd(), stdio: 'pipe' }
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const jobsByFlop = Object.fromEntries(manifest.map((job) => [job.flop, job]));

    // The explicit tail override takes precedence over the easy-board band.
    expect(jobsByFlop.As7h2d.treeProfile).toBe('recovery');
    expect(jobsByFlop.As7h2d.profileSource).toBe('exact_override');
    expect(jobsByFlop.As7h2d.overrideRuleId).toBe('exact_As7h2d');
    expect(jobsByFlop['6s5h4d']).toBeUndefined(); // terminal tails are excluded
    expect(jobsByFlop.Ts9h7d.treeProfile).toBe('recovery');
    expect(jobsByFlop.Ts9h7d.profileSource).toBe('adaptive_band');
    expect(jobsByFlop.Ts9h7d.difficultyScore).toBeGreaterThan(jobsByFlop.As7h2d.difficultyScore);
  });
});
