/* חד־פעמי: מוציא את מערכי הנתונים מקובץ המקור אל data/decks.json.
   אחרי ההרצה המקור טוען את הנתונים מה-JSON ולא מגדיר אותם בעצמו. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const src = await readFile('functional-groups.html', 'utf8');

function grab(name) {
  const start = src.indexOf('const ' + name + ' = [');
  if (start < 0) throw new Error('לא נמצא ' + name);
  let i = src.indexOf('[', start), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '[') depth++;
    else if (src[j] === ']') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, j + 1);
}

const A = (t, x, y) => ({ t, x, y });
const E = (sym, en, he, cat, role) => ({ id: sym, sym, en, he, cat, role });
const evalArr = (text) => new Function('A', 'E', 'return ' + text + ';')(A, E);

const data = {
  version: 1,
  note: 'מקור האמת לתוכן. נערך אוטומטית ע"י פונקציית add-question. סכימה: tools/deck-schema.json',
  groups: evalArr(grab('GROUPS')),
  elements: evalArr(grab('ELEMENTS')),
  iso: evalArr(grab('ISO')),
  isoTerms: evalArr(grab('ISO_TERMS')),
  isoPairs: evalArr(grab('ISO_PAIRS')),
};

await mkdir('data', { recursive: true });
await writeFile('data/decks.json', JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('data/decks.json: %d קבוצות · %d יסודות · %d צמתי עץ · %d מושגים · %d זוגות',
  data.groups.length, data.elements.length, data.iso.length, data.isoTerms.length, data.isoPairs.length);
