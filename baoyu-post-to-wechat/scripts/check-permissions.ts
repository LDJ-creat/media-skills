/// <reference path="./node-shims.d.ts" />

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function findEnvInParents(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, '.baoyu-skills', '.env');
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findFileInParents(startDir: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function log(label: string, ok: boolean, detail: string): void {
  results.push({ name: label, ok, detail });
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${label}: ${detail}`);
}

async function checkBun(): Promise<void> {
  const result = spawnSync('npx', ['-y', 'bun', '--version'], { stdio: 'pipe', timeout: 30_000 });
  if (result.status === 0) {
    log('Bun runtime', true, `v${result.stdout?.toString().trim()}`);
  } else {
    log('Bun runtime', false, 'Cannot run bun. Install: brew install oven-sh/bun/bun (macOS) or npm install -g bun');
  }
}

async function checkApiCredentials(): Promise<void> {
  const cwd = process.cwd();
  const projectBaoyuEnv = findEnvInParents(cwd);
  const projectSimpleEnv = findFileInParents(cwd, '.env');
  const userEnv = path.join(os.homedir(), '.baoyu-skills', '.env');

  let found = false;
  for (const envPath of [projectBaoyuEnv, projectSimpleEnv, userEnv]) {
    if (!envPath) continue;
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      if (content.includes('WECHAT_APP_ID')) {
        log('API credentials', true, `Found in ${envPath}`);
        found = true;
        break;
      }
    }
  }

  if (!found) {
    log('API credentials', false, 'Not found. Set WECHAT_APP_ID and WECHAT_APP_SECRET in env or .baoyu-skills/.env');
  }
}

async function main(): Promise<void> {
  console.log('=== baoyu-post-to-wechat (API-only): Environment Check ===\n');

  await checkBun();
  await checkApiCredentials();

  console.log('\n--- Summary ---');
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log('All checks passed. Ready to publish drafts via WeChat API.');
  } else {
    console.log(`${failed.length} issue(s) found:`);
    for (const f of failed) {
      console.log(`  ❌ ${f.name}: ${f.detail}`);
    }
    process.exit(1);
  }
}

await main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
