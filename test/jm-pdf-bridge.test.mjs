import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runTask } from '../src/features/jm-suomingor/pdf.js';

const python = process.platform === 'win32' ? 'python' : '/usr/bin/python3';
const pillow = spawnSync(python, ['-c', 'from PIL import Image'], { timeout: 10000 });

test('JM PDF bridge sends only worker data and clears its child handle', {
  skip: pillow.status !== 0 ? 'Python Pillow unavailable' : false
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-pdf-bridge-'));
  try {
    const image = path.join(dir, 'page.jpg');
    const output = path.join(dir, 'album.pdf');
    const generated = spawnSync(python, ['-c',
      'from PIL import Image; import sys; Image.new("RGB", (800, 1200), (90, 120, 150)).save(sys.argv[1])',
      image], { timeout: 10000 });
    assert.equal(generated.status, 0, String(generated.stderr));
    const control = { paused: false, deleted: false, child: null };
    const result = await runTask({
      python,
      task: {
        album_id: '1475771', output, descramble: false, control,
        chapters: [{ name: 'chapter', pages: [image] }]
      },
      timeoutMs: 30000
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.pagesOk, 1);
    assert.equal(control.child, null);
    assert.ok(fs.statSync(output).size > 1024);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
