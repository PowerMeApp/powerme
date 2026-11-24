/** Saves CSV text as a file. Keeps the UTF-8 BOM so Excel reads Vietnamese (fetch's text() drops it). */
export function saveCsv(text: string, filename: string) {
  const blob = new Blob([text.startsWith('﻿') ? text : `﻿${text}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
