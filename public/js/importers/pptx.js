// Reads speaker notes from a .pptx file, in slide order. PowerPoint, Keynote
// ("Export to PowerPoint") and Google Slides ("Download as .pptx") all keep
// the notes. Uses JSZip, loaded as a global script.

const REL_NOTES = /\/notesSlide$/;

function parseXml(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}

function resolvePath(fromFile, target) {
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function readRels(zip, file) {
  const relsFile = resolvePath(file, `_rels/${file.split('/').pop()}.rels`);
  const entry = zip.file(relsFile);
  if (!entry) return [];
  const doc = parseXml(await entry.async('string'));
  return [...doc.getElementsByTagName('Relationship')].map((r) => ({
    id: r.getAttribute('Id'),
    type: r.getAttribute('Type') || '',
    target: resolvePath(file, r.getAttribute('Target') || ''),
  }));
}

function notesText(doc) {
  // The notes body is the shape whose placeholder type is "body"; other
  // placeholders hold the slide image and the slide number.
  for (const sp of doc.getElementsByTagName('p:sp')) {
    const ph = sp.getElementsByTagName('p:ph')[0];
    if (!ph || ph.getAttribute('type') !== 'body') continue;
    const paragraphs = [...sp.getElementsByTagName('a:p')].map((p) =>
      [...p.getElementsByTagName('a:t')].map((t) => t.textContent).join(''),
    );
    return paragraphs.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return '';
}

/** @returns {Promise<string[]>} one entry per slide ('' when a slide has no notes) */
export async function readPptxNotes(file) {
  if (!window.JSZip) throw new Error('JSZip을 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
  const zip = await window.JSZip.loadAsync(file);
  const presFile = 'ppt/presentation.xml';
  const pres = zip.file(presFile);
  if (!pres) throw new Error('PowerPoint(.pptx) 파일이 아닙니다.');
  const presDoc = parseXml(await pres.async('string'));
  const rels = new Map((await readRels(zip, presFile)).map((r) => [r.id, r]));
  const slideIds = [...presDoc.getElementsByTagName('p:sldId')];
  const notes = [];
  for (const sldId of slideIds) {
    const rel = rels.get(sldId.getAttribute('r:id'));
    if (!rel) {
      notes.push('');
      continue;
    }
    const notesRel = (await readRels(zip, rel.target)).find((r) => REL_NOTES.test(r.type));
    const entry = notesRel && zip.file(notesRel.target);
    notes.push(entry ? notesText(parseXml(await entry.async('string'))) : '');
  }
  return notes;
}
