/* בדיקת עשן — טוענת את www/index.html ב-DOM וירטואלי ומוודאת שהאפליקציה עולה
   ושכל חבילה מייצרת שאלות תקינות בכל מצב. נכשלת = לא מדפלויים.
   שימוש:  node tools/smoke.mjs        */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDS = 8;          /* כל מצב נבנה כמה פעמים — הבחירה אקראית */
const fail = [];

const html = await readFile(join(ROOT, 'www', 'index.html'), 'utf8');

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => fail.push('שגיאת JS בטעינה: ' + e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://shassaf.github.io/shinun-biochem/',
  virtualConsole: vc,
  /* jsdom לא מממש את אלה — חייבים להזריק לפני שסקריפטי הדף רצים */
  beforeParse(w) {
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.scrollTo = () => {};   /* jsdom מגדיר stub שזורק, אז דורסים אותו */
  },
});
const win = dom.window;

await new Promise((r) => win.addEventListener('load', r, { once: true }));

const { document } = win;
const check = (cond, msg) => { if (!cond) fail.push(msg); };

/* 1 — מסך הבית עלה */
check(!!document.querySelector('.deck-list'), 'מסך הבית לא נרנדר');
const cards = document.querySelectorAll('.deck-card');
check(cards.length > 0, 'אין אף חבילה במסך הבית');

/* 2 — כל חבילה, בכל מצב, מייצרת שאלות תקינות.
   `const DECKS` בסקריפט קלאסי יושב בסביבה הלקסיקלית ולא על window — לכן eval. */
const DECKS = win.eval('typeof DECKS !== "undefined" ? DECKS : null');
check(Array.isArray(DECKS) && DECKS.length >= 3, 'DECKS חסר או קטן מהצפוי');

for (const deck of DECKS ?? []) {
  check(!!deck.title, `${deck.id}: אין כותרת`);
  check(deck.items?.length > 0, `${deck.id}: אין פריטים`);

  for (const mode of deck.modes ?? []) {
    check(!!mode.title, `${deck.id}/${mode.id}: אין כותרת למצב`);
    for (let r = 0; r < ROUNDS; r++) {
      let qs;
      try {
        qs = deck.build(mode.id);
      } catch (e) {
        fail.push(`${deck.id}/${mode.id}: build נפל — ${e.message}`);
        break;
      }
      if (!qs?.length) { fail.push(`${deck.id}/${mode.id}: לא נוצרו שאלות`); break; }
      for (const q of qs) {
        if (q.options?.length !== 4) { fail.push(`${deck.id}/${mode.id}: ${q.options?.length} אפשרויות במקום 4`); break; }
        if (!q.options.some((o) => o.id === q.answer)) { fail.push(`${deck.id}/${mode.id}: התשובה לא בין האפשרויות`); break; }
        if (new Set(q.options.map((o) => o.id)).size !== 4) { fail.push(`${deck.id}/${mode.id}: אפשרויות כפולות`); break; }
        if (!q.label) { fail.push(`${deck.id}/${mode.id}: אין ניסוח לשאלה`); break; }
      }
    }
  }
}

/* 3 — מסך חידון אמיתי נרנדר בלי לזרוק */
try {
  win.eval(`startQuiz(${JSON.stringify(DECKS[0].id)}, ${JSON.stringify(DECKS[0].modes[0].id)})`);
  check(!!document.querySelector('.stage'), 'מסך החידון לא נרנדר');
  check(document.querySelectorAll('.opt').length === 4, 'אין 4 כפתורי תשובה');
} catch (e) {
  fail.push('רינדור חידון נפל: ' + e.message);
}

dom.window.close();

if (fail.length) {
  console.error('בדיקת העשן נכשלה:\n' + [...new Set(fail)].map((f) => '  · ' + f).join('\n'));
  process.exit(1);
}
console.log('בדיקת העשן עברה — %d חבילות, %d פריטים',
  DECKS.length, DECKS.reduce((a, d) => a + d.items.length, 0));
