import fs from 'fs';
import { runInNewContext } from 'node:vm';
import PNGNode from '../lib/png-js.cjs';
import PNGNodeESM from '../lib/png-js.js';
import PNGBrowser from '../lib/png-js.browser.cjs';
import PNGBrowserESM from '../lib/png-js.browser.js';

const decoders = [
  ['node CJS', PNGNode],
  ['node ESM', PNGNodeESM],
  ['packaged browser CJS', PNGBrowser],
  ['packaged browser ESM', PNGBrowserESM],
  ['standalone browser', PNG],
];

const reportedBuffer = () =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJgAAAAHp6WnoAAAAASUVORK5CYII=',
    'base64',
  );

const validBuffer = () => fs.readFileSync('test/images/rgb-8bit.png');

// Offset of the length field of the first chunk with the given type.
function findChunk(buffer, type) {
  let pos = 8;
  while (pos + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(pos);
    const section = buffer.toString('ascii', pos + 4, pos + 8);
    if (section === type) return pos;
    pos += 12 + size;
  }
  throw new Error(`no ${type} chunk found`);
}

// A normal test timeout cannot interrupt a synchronous parser loop. The VM
// deadline stops it and fails the expected corruption-error assertion instead.
function parse(Ctor, buffer) {
  return runInNewContext(
    'new Ctor(buffer)',
    { Ctor, buffer },
    { timeout: 1000 },
  );
}

describe.each(decoders)('%s chunk bounds', (_name, Ctor) => {
  const expectCorrupt = (buffer) =>
    expect(() => parse(Ctor, buffer)).toThrow('Incomplete or corrupt PNG file');

  test('rejects the reported denial-of-service sample', () => {
    expectCorrupt(reportedBuffer());
  });

  test.each([0x7fffffff, 0x80000000, 0xfffffff4, 0xffffffff])(
    'rejects an oversized unknown chunk with length %i',
    (length) => {
      const buffer = reportedBuffer();
      // A signed length of -12 (0xfffffff4) revisits this exact chunk forever.
      buffer.writeUInt32BE(length, 33);
      expectCorrupt(buffer);
    },
  );

  test.each([0, 3, 7])('rejects a %i-byte chunk header', (length) => {
    const buffer = validBuffer();
    const idat = findChunk(buffer, 'IDAT');
    expectCorrupt(buffer.subarray(0, idat + length));
  });

  test('rejects a truncated IDAT payload', () => {
    const buffer = validBuffer();
    const idat = findChunk(buffer, 'IDAT');
    const size = buffer.readUInt32BE(idat);
    expectCorrupt(buffer.subarray(0, idat + 8 + size - 1));
  });

  test.each([0, 1, 2, 3])('rejects an IDAT CRC with %i bytes', (length) => {
    const buffer = validBuffer();
    const idat = findChunk(buffer, 'IDAT');
    const size = buffer.readUInt32BE(idat);
    expectCorrupt(buffer.subarray(0, idat + 8 + size + length));
  });

  test.each([0, 1, 2, 3])('rejects an IEND CRC with %i bytes', (length) => {
    const buffer = validBuffer();
    const iend = findChunk(buffer, 'IEND');
    expectCorrupt(buffer.subarray(0, iend + 8 + length));
  });

  test('rejects an IDAT length larger than the remaining input', () => {
    const buffer = validBuffer();
    buffer.writeUInt32BE(buffer.length, findChunk(buffer, 'IDAT'));
    expectCorrupt(buffer);
  });

  test('rejects an under-declared IDAT that exposes a backwards chunk length', () => {
    const buffer = validBuffer();
    const idat = findChunk(buffer, 'IDAT');
    const header = Buffer.alloc(8);
    header.write('IDAT', 4, 'ascii'); // Declares an empty payload.
    const payload = Buffer.alloc(12);
    // The first four payload bytes are misinterpreted as the IDAT CRC,
    // exposing the next eight bytes as a chunk header with signed length -12.
    payload.writeUInt32BE(0xfffffff4, 4);
    payload.write('zzZz', 8, 'ascii');
    expectCorrupt(
      Buffer.concat([
        buffer.subarray(0, idat),
        header,
        payload,
        Buffer.alloc(4),
        buffer.subarray(findChunk(buffer, 'IEND')),
      ]),
    );
  });
});

// Signature and dimension validation remain specific to the packaged decoder.
describe('malformed input', () => {
  test('broken.png fixture', () => {
    const buffer = fs.readFileSync('images/broken.png');
    expect(() => new PNGNode(buffer)).toThrow('Incomplete or corrupt PNG file');
  });

  test('empty buffer', () => {
    expect(() => new PNGNode(Buffer.alloc(0))).toThrow('Invalid PNG signature');
  });

  test('signature only', () => {
    const buffer = validBuffer().subarray(0, 8);
    expect(() => new PNGNode(buffer)).toThrow('Incomplete or corrupt PNG file');
  });

  test('bad signature', () => {
    const buffer = validBuffer();
    buffer[0] = 0x00;
    expect(() => new PNGNode(buffer)).toThrow('Invalid PNG signature');
  });

  test('truncated mid-IDAT', () => {
    const buffer = validBuffer();
    const idat = findChunk(buffer, 'IDAT');
    expect(() => new PNGNode(buffer.subarray(0, idat + 12))).toThrow(
      'Incomplete or corrupt PNG file',
    );
  });

  test('chunk length larger than file', () => {
    const buffer = validBuffer();
    buffer.writeUInt32BE(0xffffffff, findChunk(buffer, 'IDAT'));
    expect(() => new PNGNode(buffer)).toThrow('Incomplete or corrupt PNG file');
  });

  test('zero dimensions', () => {
    const buffer = validBuffer();
    const ihdr = findChunk(buffer, 'IHDR');
    buffer.writeUInt32BE(0, ihdr + 8); // width field inside IHDR payload
    expect(() => new PNGNode(buffer)).toThrow(
      'Invalid PNG dimensions: width and height must be nonzero',
    );
  });

  test('valid file still parses', () => {
    const png = new PNGNode(validBuffer());
    expect(png.width).toBeGreaterThan(0);
    expect(png.height).toBeGreaterThan(0);
  });
});
