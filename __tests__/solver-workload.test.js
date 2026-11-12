const fs = require('fs');
const os = require('os');
const path = require('path');
const { chunkJobs } = require('../solver-script-generator');
const { manifestFilename, writePhaseWorkload } = require('../solver-workload');

describe('solver workload helpers', () => {
  test('chunks jobs into stable manifest-sized slices', () => {
    const chunks = chunkJobs([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }], 2);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual([{ id: 1 }, { id: 2 }]);
    expect(chunks[2]).toEqual([{ id: 5 }]);
    expect(manifestFilename(0)).toBe('part-001.json');
  });

  test('writes phase workload scripts, manifests, and index', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solver-workload-'));
    const outputRoot = path.join(workDir, 'phase1');

    const solverDir = path.join(workDir, 'solver');
    const rangeDir = path.join(solverDir, 'ranges', '6max_range', 'BTN', '2.5bb', 'BB', 'Call');
    fs.mkdirSync(rangeDir, { recursive: true });
    fs.writeFileSync(path.join(rangeDir, 'BTN_range.txt'), 'AA:1.0');
    fs.writeFileSync(path.join(rangeDir, 'BB_range.txt'), 'KK:1.0');

    const result = writePhaseWorkload({
      solverDir,
      outputRoot,
      positionPair: 'BTN_vs_BB',
      line: 'SRP',
      stackBb: 50,
      treeProfile: 'benchmark',
      chunkSize: 2,
      flops: ['As7h2d', 'Ks7h2d', 'Qs7h2d'],
    });

    expect(result.jobs).toHaveLength(3);
    expect(result.chunks).toHaveLength(2);
    expect(fs.existsSync(result.indexPath)).toBe(true);
    expect(fs.existsSync(path.join(result.manifestsDir, 'part-001.json'))).toBe(true);

    const index = JSON.parse(fs.readFileSync(result.indexPath, 'utf8'));
    expect(index.totalJobs).toBe(3);
    expect(index.totalChunks).toBe(2);
    expect(index.manifests[0].filename).toBe('part-001.json');
  });
});
