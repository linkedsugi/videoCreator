import * as pdfjs from '/vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const MAX_W = 1920;
const MAX_H = 1080;

/**
 * Renders each PDF page to a PNG that fits 1920×1080, calling
 * `onPage(pageNumber, pngBlob, pageCount)` in order.
 */
export async function renderPdfPages(file, onPage) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({
    data,
    cMapUrl: '/vendor/pdfjs-cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs-fonts/',
  }).promise;
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(MAX_W / base.width, MAX_H / base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      page.cleanup();
      await onPage(n, blob, pdf.numPages);
    }
    return pdf.numPages;
  } finally {
    pdf.destroy();
  }
}
