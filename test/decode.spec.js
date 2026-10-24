import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { setImmediate } from 'timers';
import { deflateSync } from 'zlib';
import PNGNode from '../lib/png-js.cjs';
import PNGBrowser from '../lib/png-js.browser.cjs';

function makePng(compressed, { width = 1, height = 1 } = {}) {
  const chunk = (type, data) => {
    // The decoder does not validate CRCs.
    const buffer = Buffer.alloc(data.length + 12);
    buffer.writeUInt32BE(data.length, 0);
    buffer.write(type, 4, 'ascii');
    data.copy(buffer, 8);
    return buffer;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2; // RGB, without alpha.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const compressedPixels = deflateSync(Buffer.from([0, 12, 34, 56]));
const valid = makePng(compressedPixels);
const oversized = makePng(compressedPixels, {
  width: 0x7fffffff,
  height: 0x7fffffff,
});
const corrupt = makePng(Buffer.from([0, 0, 0, 0]));
const invalidFilter = makePng(deflateSync(Buffer.from([5, 12, 34, 56])));
const failures = [
  ['corrupt', corrupt, /./],
  ['invalid-filter', invalidFilter, /Invalid filter algorithm: 5/],
];
let directory;
const filePath = (name) => path.join(directory, `${name}.png`);

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'png-js-decode-'));
  for (const [name, buffer] of [
    ['valid', valid],
    ['oversized', oversized],
    ['signature', Buffer.from('not a PNG')],
    ['truncated', valid.subarray(0, valid.length - 1)],
    ...failures,
  ]) {
    fs.writeFileSync(filePath(name), buffer);
  }
});

afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

async function callbackResult(start) {
  const calls = [];
  await new Promise((resolve) => {
    start((...args) => {
      calls.push(args);
      resolve();
    });
  });
  // Allow an accidental second callback in the same operation to run.
  await new Promise((resolve) => setImmediate(resolve));
  expect(calls).toHaveLength(1);
  return calls[0];
}

function expectCallbackException(modulePath, method, file) {
  // A subprocess isolates deliberately uncaught consumer exceptions from Vitest.
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const PNG = require(${JSON.stringify(modulePath)});
        const expected = new Error('consumer callback failed');
        let calls = 0;
        let escaped = false;
        process.on('uncaughtException', err => {
          assert.strictEqual(err, expected);
          assert.strictEqual(calls, 1);
          escaped = true;
          console.log('consumer exception propagated once');
        });
        process.on('beforeExit', () => {
          assert.strictEqual(escaped, true);
          assert.strictEqual(calls, 1);
        });
        const callback = () => {
          calls++;
          throw expected;
        };
        const file = ${JSON.stringify(file)};
        const method = ${JSON.stringify(method)};
        if (method === 'static') PNG.decode(file, callback);
        else new PNG(fs.readFileSync(file))[method](callback);
      `,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.stdout).toBe('consumer exception propagated once\n');
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

describe('PNG.decode', () => {
  test('returns a null error and RGBA pixels on success', async () => {
    const args = await callbackResult((callback) =>
      PNGNode.decode(filePath('valid'), callback),
    );
    expect(args).toHaveLength(2);
    expect(args[0]).toBeNull();
    expect(Array.from(args[1])).toEqual([12, 34, 56, 255]);
  });

  test('returns the filesystem error for a missing file', async () => {
    const missing = filePath('missing');
    const args = await callbackResult((callback) =>
      PNGNode.decode(missing, callback),
    );
    expect(args).toHaveLength(1);
    expect(args[0]).toMatchObject({ code: 'ENOENT', path: missing });
  });

  test('returns an allocation error for oversized PNG dimensions', async () => {
    const args = await callbackResult((callback) =>
      PNGNode.decode(filePath('oversized'), callback),
    );
    expect(args).toHaveLength(1);
    expect(args[0].name).toBe('RangeError');
  });

  test.each([
    ['signature', /Invalid PNG signature/],
    ['truncated', /Incomplete or corrupt PNG file/],
    ...failures.map(([name, , message]) => [name, message]),
  ])('returns errors for %s data', async (name, message) => {
    const args = await callbackResult((callback) =>
      PNGNode.decode(filePath(name), callback),
    );
    expect(args).toHaveLength(1);
    expect(args[0].message).toMatch(message);
  });

  test.each(['valid', 'missing', 'signature', 'invalid-filter'])(
    'propagates consumer exceptions for %s data without retrying',
    (name) => {
      expectCallbackException('./lib/png-js.cjs', 'static', filePath(name));
    },
  );
});

describe.each([
  ['node', PNGNode, './lib/png-js.cjs'],
  ['packaged browser', PNGBrowser, './lib/png-js.browser.cjs'],
])('%s instance decoding', (_name, Ctor, modulePath) => {
  describe.each(['decode', 'decodePixels'])('%s', (method) => {
    test('returns a null error and unchanged pixels on success', async () => {
      const png = new Ctor(valid);
      const args = await callbackResult((callback) => png[method](callback));
      expect(args).toHaveLength(2);
      expect(args[0]).toBeNull();
      expect(Array.from(args[1])).toEqual(
        method === 'decode' ? [12, 34, 56, 255] : [12, 34, 56],
      );
    });

    test.each(failures)(
      'returns errors for %s data',
      async (_name, data, message) => {
        const png = new Ctor(data);
        const args = await callbackResult((callback) => png[method](callback));
        expect(args).toHaveLength(1);
        expect(args[0].message).toMatch(message);
      },
    );

    test('returns an allocation error for oversized PNG dimensions', async () => {
      const png = new Ctor(oversized);
      const args = await callbackResult((callback) => png[method](callback));
      expect(args).toHaveLength(1);
      expect(args[0].name).toBe('RangeError');
    });

    test.each(['valid', 'corrupt', 'invalid-filter'])(
      'propagates consumer exceptions for %s data without retrying',
      (name) => {
        expectCallbackException(modulePath, method, filePath(name));
      },
    );
  });
});
