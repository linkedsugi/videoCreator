import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SlideConverter, libreOffice } from '../server/convert.js';
import { createApp } from '../server/index.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'vc-convert-'));

function fake(id, { available = true, fail = null } = {}) {
  return {
    id,
    label: id,
    available: async () => available,
    async convert(input, output) {
      if (fail) throw new Error(fail);
      await fsp.writeFile(output, `converted by ${id} from ${path.basename(input)}`);
    },
  };
}

test('falls back to the next converter when one fails', async () => {
  const conv = new SlideConverter(await tmp(), [fake('a', { fail: 'no access' }), fake('b', { available: false }), fake('c')]);
  const { file, via } = await conv.convert(Buffer.from('x'), '.pptx', 'pdf');
  assert.equal(via, 'c');
  assert.match(await fsp.readFile(file, 'utf8'), /converted by c/);
  assert.deepEqual(await conv.available(), ['a', 'c']);
});

test('reports every failure, or that nothing can convert', async () => {
  const conv = new SlideConverter(await tmp(), [fake('a', { fail: 'no access' }), fake('b', { fail: 'timeout' })]);
  await assert.rejects(conv.convert(Buffer.from('x'), '.ppt', 'pdf'), (err) => err.status === 422 && /a: no access/.test(err.message) && /b: timeout/.test(err.message));
  const none = new SlideConverter(await tmp(), [fake('a', { available: false })]);
  await assert.rejects(none.convert(Buffer.from('x'), '.pptx', 'pdf'), /프로그램/);
});

const hasLibreOffice = await libreOffice.available();

test('converts PowerPoint files with LibreOffice through the API', { skip: !hasLibreOffice && 'LibreOffice not installed', timeout: 180_000 }, async () => {
  const dir = await tmp();
  const { app } = await createApp({ dataDir: dir, ffmpeg: null, converter: new SlideConverter(path.join(dir, '_convert'), [libreOffice]) });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pptx = await fsp.readFile(new URL('deck.pptx', FIXTURES));
    const res = await fetch(`${base}/api/convert?to=pdf&name=deck.pptx`, { method: 'POST', body: pptx });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-converted-by'), 'libreoffice');
    const pdf = new Uint8Array(await res.arrayBuffer());
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: pdf }).promise;
    assert.equal(doc.numPages, 3, 'the hidden slide is left out, like PowerPoint and Keynote do');

    const ppt = await fsp.readFile(new URL('deck.ppt', FIXTURES));
    const res2 = await fetch(`${base}/api/convert?to=pptx&name=deck.ppt`, { method: 'POST', body: ppt });
    assert.equal(res2.status, 200);
    const zip = Buffer.from(await res2.arrayBuffer());
    assert.equal(zip.subarray(0, 2).toString(), 'PK');

    const bad = await fetch(`${base}/api/convert?to=pdf&name=notes.txt`, { method: 'POST', body: 'x' });
    assert.equal(bad.status, 400);
    const leftovers = await fsp.readdir(path.join(dir, '_convert'));
    assert.deepEqual(leftovers, [], 'converted files are cleaned up');
  } finally {
    server.close();
  }
});
