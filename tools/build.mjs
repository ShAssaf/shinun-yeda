/* בונה שני תוצרים מ-src/app.html + data/decks.json:
     www/index.html    — גרסת ה-PWA/אנדרואיד: גופנים מוטמעים, manifest, service worker
     dist/artifact.html — קובץ בודד להעלאה כארטיפקט: גופנים מ-Google Fonts
   שימוש:  node tools/build.mjs        */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'src', 'app.html');
const DATA = join(ROOT, 'data', 'decks.json');
const CONFIG = join(ROOT, 'data', 'config.json');

const PWA_HEAD = `<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
`;

const PWA_TAIL = `
<script>
/* רישום service worker — רק בהגשה מ-http/https (לא בפתיחת קובץ מקומי) */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  });
  /* גרסה חדשה תפסה שליטה — נטענים מחדש פעם אחת כדי להציג אותה */
  var swReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (swReloaded) return;
    swReloaded = true;
    location.reload();
  });
}
</script>
`;

const template = await readFile(TEMPLATE, 'utf8');
const raw = await readFile(DATA, 'utf8');
const parsed = JSON.parse(raw);           /* אימות — בנייה נכשלת על JSON שבור */

/* </script> בתוך מחרוזת היה סוגר את התג המכיל */
const inlined = JSON.stringify(parsed).replace(/<\//g, '<\\/');
let withData = template.replace('<!--DECK_DATA-->',
  '<script id="deck-data" type="application/json">' + inlined + '</script>');
if (withData === template) throw new Error('לא נמצא מציין המיקום <!--DECK_DATA-->');

let cfg = {};
try { cfg = JSON.parse(await readFile(CONFIG, 'utf8')); } catch {}
withData = withData.replace('<!--APP_CONFIG-->',
  '<script id="app-config" type="application/json">'
  + JSON.stringify(cfg).replace(/<\//g, '<\\/') + '</script>');

/* ---- www/index.html ---- */
let pwa = withData;
let offlineFonts = false;
try { await access(join(ROOT, 'www', 'fonts.css')); offlineFonts = true; } catch {}
if (offlineFonts) {
  pwa = pwa
    .replace(/<link rel="preconnect"[^>]*>\n/g, '')
    .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/,
             '<link rel="stylesheet" href="fonts.css">');
}
pwa = pwa.replace(/(<\/title>\n)/, '$1' + PWA_HEAD) + PWA_TAIL;
await mkdir(join(ROOT, 'www'), { recursive: true });
await writeFile(join(ROOT, 'www', 'index.html'), pwa, 'utf8');

/* ---- www/sw.js ---- */
/* חותמים את ה-SW בטביעת אצבע של הדף, כך שכל דיפלוי מתקין אותו מחדש
   ומפנה את הקאש הישן. בלי זה הגרסה הראשונה שנתפסה נשארת לנצח. */
const stamp = createHash('sha256').update(pwa).digest('hex').slice(0, 12);
const sw = (await readFile(join(ROOT, 'src', 'sw.js'), 'utf8')).replace('__BUILD__', stamp);
if (sw.includes('__BUILD__')) throw new Error('לא הוחלף מציין הגרסה ב-sw.js');
await writeFile(join(ROOT, 'www', 'sw.js'), sw, 'utf8');

/* ---- dist/artifact.html ---- */
await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(join(ROOT, 'dist', 'artifact.html'), withData, 'utf8');

const counts = ['groups', 'elements', 'iso', 'isoTerms', 'isoPairs']
  .map(k => `${k}:${(parsed[k] || []).length}`).join(' · ');
console.log('www/index.html %d KB (גופנים %s) · dist/artifact.html %d KB',
  Math.round(pwa.length / 1024), offlineFonts ? 'מוטמעים' : 'מ-Google',
  Math.round(withData.length / 1024));
console.log('תוכן: %s · גרסת SW %s', counts, stamp);
console.log('כפתור הוספת שאלה: %s', cfg.addQuestionUrl ? 'פעיל' : 'כבוי (data/config.json ריק)');
