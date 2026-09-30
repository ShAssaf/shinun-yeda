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

const PWA_HEAD = `<meta name="app-build" content="__BUILD__">
<link rel="manifest" href="manifest.webmanifest">
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
  /* גרסה חדשה תפסה שליטה — נטענים מחדש פעם אחת כדי להציג אותה.
     לא בביקור הראשון (אין גרסה קודמת להחליף, וזו הייתה טעינה מחדש
     בלי סיבה), ולא באמצע חידון או גיליון פתוח: הטעינה נדחית עד שאין
     מה לאבד. התרגול עצמו כבר שמור במכשיר, אבל הסבב שבאמצע לא. */
  var hadController = !!navigator.serviceWorker.controller;
  var swReloaded = false;
  /* גם סנכרון בטיסה הוא "באמצע": טעינה מחדש קוטעת אותו, וכל בקשה
     שנקטעה נרשמה ביומן כ-Failed to fetch */
  var reloadWhenIdle = function () {
    if (swReloaded) return;
    var busy = false;
    try {
      busy = !!(quiz && !quiz.done) || !!document.querySelector('.sheet-bg') ||
             !!syncingAll || !!cardSync;
    } catch (e) {}
    if (busy) { setTimeout(reloadWhenIdle, 5000); return; }
    swReloaded = true;
    try { leaving = true; } catch (e) {}
    location.reload();
  };
  /* ה-SW החדש אומר איזו בנייה של הדף הוא מגיש. אחרי דיפלוי, פתיחת
     האפליקציה מביאה את הדף החדש ברשת-תחילה, וה-SW החדש תופס שליטה
     שניות אחר כך — טעינה מחדש אז לא מחליפה כלום, רק מחזירה למסך
     הבית באמצע הסנכרון. בלי תשובה — טוענים מחדש, כמו קודם. */
  var sameBuild = function (sw) {
    var mine = (document.querySelector('meta[name="app-build"]') || {}).content;
    return new Promise(function (resolve) {
      if (!sw || !mine || typeof MessageChannel !== 'function') return resolve(false);
      var ch = new MessageChannel();
      var t = setTimeout(function () { resolve(false); }, 3000);
      ch.port1.onmessage = function (e) { clearTimeout(t); resolve(e.data === mine); };
      try { sw.postMessage({ type: 'page-build' }, [ch.port2]); }
      catch (e) { clearTimeout(t); resolve(false); }
    });
  };
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) { hadController = true; return; }
    sameBuild(navigator.serviceWorker.controller).then(function (same) {
      if (!same) reloadWhenIdle();
    });
  });
}
</script>
`;

const template = await readFile(TEMPLATE, 'utf8');
const raw = await readFile(DATA, 'utf8');
const parsed = JSON.parse(raw);           /* אימות — בנייה נכשלת על JSON שבור */

/* </script> בתוך מחרוזת היה סוגר את התג המכיל */
const inlined = JSON.stringify(parsed).replace(/<\//g, '<\\/');
/* פונקציית החלפה ולא מחרוזת: $& או $' בתוך התוכן היו משכפלים קטעים מהתבנית */
let withData = template.replace('<!--DECK_DATA-->',
  () => '<script id="deck-data" type="application/json">' + inlined + '</script>');
if (withData === template) throw new Error('לא נמצא מציין המיקום <!--DECK_DATA-->');

let cfg = {};
try { cfg = JSON.parse(await readFile(CONFIG, 'utf8')); } catch {}
if (!withData.includes('<!--APP_CONFIG-->')) throw new Error('לא נמצא מציין המיקום <!--APP_CONFIG-->');
const cfgTag = '<script id="app-config" type="application/json">'
  + JSON.stringify(cfg).replace(/<\//g, '<\\/') + '</script>';
withData = withData.replace('<!--APP_CONFIG-->', () => cfgTag);

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
pwa = pwa.replace(/(<\/title>\n)/, (m) => m + PWA_HEAD) + PWA_TAIL;
/* חתימת הבנייה נכנסת לדף כדי שכל תקלה ביומן תסגיר מאיזו גרסה הגיעה */
const build = createHash('sha256').update(withData).digest('hex').slice(0, 12);
pwa = pwa.replace('__BUILD__', build);
await mkdir(join(ROOT, 'www'), { recursive: true });
await writeFile(join(ROOT, 'www', 'index.html'), pwa, 'utf8');

/* ---- www/sw.js ---- */
/* חותמים את ה-SW בטביעת אצבע של הדף, כך שכל דיפלוי מתקין אותו מחדש
   ומפנה את הקאש הישן. בלי זה הגרסה הראשונה שנתפסה נשארת לנצח.
   גם קוד ה-SW נכנס לטביעה: שינוי בו בלבד חייב שם קאש חדש, אחרת
   הקאש הישן שורד את ההתקנה. */
const swSrc = await readFile(join(ROOT, 'src', 'sw.js'), 'utf8');
/* גם הקבצים שה-SW מגיש מהקאש קודם — גופנים, אייקונים, manifest. שינוי
   רק באחד מהם חייב קאש חדש, אחרת הישן ממשיך להיות מוגש. */
const stampHash = createHash('sha256').update(pwa).update(swSrc);
for (const f of ['fonts.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
                 'icons/maskable-512.png', 'icons/apple-touch-icon.png']) {
  try { stampHash.update(await readFile(join(ROOT, 'www', f))); } catch {}
}
const stamp = stampHash.digest('hex').slice(0, 12);
/* ה-SW יודע גם את חתימת הדף, כדי שדף שכבר מריץ אותה לא ייטען מחדש */
const sw = swSrc.replace('__BUILD__', stamp).replace('__PAGE__', build);
if (sw.includes('__BUILD__') || sw.includes('__PAGE__')) throw new Error('לא הוחלף מציין הגרסה ב-sw.js');
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
