/* מוריד את הגופנים מ-Google Fonts ומטמיע אותם כ-data URI ב-www/fonts.css,
   כדי שהאפליקציה תיראה נכון גם בלי אינטרנט (APK / אופליין).
   שימוש:  node tools/embed-fonts.mjs        */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'www', 'fonts.css');

const CSS_URL = 'https://fonts.googleapis.com/css2'
  + '?family=Frank+Ruhl+Libre:wght@500;700'
  + '&family=Heebo:wght@400;500;700'
  + '&family=IBM+Plex+Sans:wght@400;500;600'
  + '&display=swap';

/* UA של כרום — אחרת גוגל מגישה ttf במקום woff2 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const KEEP = new Set(['hebrew', 'latin']);

const css = await fetch(CSS_URL, { headers: { 'User-Agent': UA } }).then(r => {
  if (!r.ok) throw new Error('Google Fonts החזיר ' + r.status);
  return r.text();
});

/* הקובץ בנוי כ:  /* subset *\/  ואחריו @font-face { ... } */
const blocks = [];
const re = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
let m;
while ((m = re.exec(css)) !== null) blocks.push({ subset: m[1], text: m[2] });
if (!blocks.length) throw new Error('לא נמצאו בלוקים של @font-face');

let kept = 0, bytes = 0;
const out = [];
for (const b of blocks) {
  if (!KEEP.has(b.subset)) continue;
  const url = (b.text.match(/url\((https:\/\/[^)]+\.woff2)\)/) || [])[1];
  if (!url) continue;
  const buf = Buffer.from(await fetch(url, { headers: { 'User-Agent': UA } }).then(r => r.arrayBuffer()));
  bytes += buf.length;
  kept++;
  out.push(b.text
    .replace(/src:[^;]+;/, `src: url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2');`)
    .replace(/\/\*[^*]*\*\//g, ''));
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, '/* גופנים מוטמעים — נוצר ע"י tools/embed-fonts.mjs. אין לערוך ידנית. */\n'
  + out.join('\n') + '\n', 'utf8');
console.log('הוטמעו %d חתכי גופן, %d KB גולמי → www/fonts.css', kept, Math.round(bytes / 1024));
