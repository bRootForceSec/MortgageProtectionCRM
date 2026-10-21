import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Scanned lead pages saved as JPEG 2000 (or JBIG2) images used to show as a blank white page in the review window.

const PORT = 5196;
let server: ChildProcess;
let launchUrl = '';

test.beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-e2e-'));
  server = spawn('node', ['dist/server/main.js'], { env: { ...process.env, MPCRM_DATA_DIR: dataDir, MPCRM_PORT: String(PORT) } });
  launchUrl = await new Promise<string>((resolve, reject) => {
    let out = '';
    server.stdout!.on('data', (d) => {
      out += d;
      const m = out.match(/Open: (http\S+)/);
      if (m) resolve(m[1]!);
    });
    server.on('exit', (c) => reject(new Error(`server exited ${c}: ${out}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15_000);
  });
});

test.afterAll(() => {
  server?.kill('SIGTERM');
});

test('a scanned page saved as JPEG 2000 shows in the review window', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-jpx-'));
  const file = path.join(dir, 'IN_574_1-1.pdf');
  fs.copyFileSync(path.resolve('test/fixtures/scan-jpeg2000.pdf'), file);
  const warnings: string[] = [];
  page.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));

  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.locator('input[type=file]:not([webkitdirectory])').first().setInputFiles(file);
  // With or without an AI reader set up, the page isn't a lead, so it needs a look.
  await page.getByRole('button', { name: 'Check it now' }).click({ timeout: 45_000 });

  const canvas = page.locator('canvas[aria-label="Page 1"]');
  await expect(canvas).toBeVisible();
  // The test page is black stripes on white: some of it must be dark once drawn.
  await expect
    .poll(() =>
      canvas.evaluate((el: HTMLCanvasElement) => {
        const d = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data;
        let dark = 0;
        // Dark and drawn (an empty canvas is transparent black).
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 200 && d[i]! < 128) dark++;
        return dark / (d.length / 4);
      }),
    )
    .toBeGreaterThan(0.1);
  expect(warnings.filter((w) => /decode image|wasmUrl/i.test(w))).toEqual([]);
});
