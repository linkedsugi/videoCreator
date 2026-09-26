// Reads slide titles, speaker notes and hidden flags from a .pptx file, in
// slide order. PowerPoint, Keynote ("Export to PowerPoint") and Google Slides
// ("Download as .pptx") all keep the notes. Uses JSZip, loaded as a global script.

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

/** Text of the first shape whose placeholder type is one of `types`. */
function placeholderText(doc, types) {
  for (const sp of doc.getElementsByTagName('p:sp')) {
    const ph = sp.getElementsByTagName('p:ph')[0];
    if (!ph || !types.includes(ph.getAttribute('type'))) continue;
    const paragraphs = [...sp.getElementsByTagName('a:p')].map((p) =>
      [...p.getElementsByTagName('a:t')].map((t) => t.textContent).join(''),
    );
    return paragraphs.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return '';
}

/**
 * @returns {Promise<{title: string, notes: string, hidden: boolean}[]>} one entry per slide
 */
export async function readPptxSlides(file) {
  if (!window.JSZip) throw new Error('JSZip을 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
  let zip;
  try {
    zip = await window.JSZip.loadAsync(file);
  } catch {
    throw new Error('.pptx 파일을 열 수 없습니다.');
  }
  const presFile = 'ppt/presentation.xml';
  const pres = zip.file(presFile);
  if (!pres) throw new Error('PowerPoint(.pptx) 파일이 아닙니다.');
  const presDoc = parseXml(await pres.async('string'));
  const rels = new Map((await readRels(zip, presFile)).map((r) => [r.id, r]));
  const slides = [];
  for (const sldId of presDoc.getElementsByTagName('p:sldId')) {
    const rel = rels.get(sldId.getAttribute('r:id'));
    const slideEntry = rel && zip.file(rel.target);
    if (!slideEntry) {
      slides.push({ title: '', notes: '', hidden: false });
      continue;
    }
    const slideDoc = parseXml(await slideEntry.async('string'));
    const notesRel = (await readRels(zip, rel.target)).find((r) => REL_NOTES.test(r.type));
    const notesEntry = notesRel && zip.file(notesRel.target);
    slides.push({
      title: placeholderText(slideDoc, ['title', 'ctrTitle']).replace(/\s+/g, ' '),
      notes: notesEntry ? placeholderText(parseXml(await notesEntry.async('string')), ['body']) : '',
      hidden: slideDoc.documentElement.getAttribute('show') === '0',
    });
  }
  return slides;
}

/**
 * Matches deck slides to PDF pages. PDF exports leave out hidden slides by
 * default, so visible slides are tried first.
 */
export function matchSlidesToPages(slides, pageCount) {
  const visible = slides.filter((s) => !s.hidden);
  if (visible.length === pageCount) return { list: visible, exact: true };
  if (slides.length === pageCount) return { list: slides, exact: true };
  return { list: visible, exact: false };
}
