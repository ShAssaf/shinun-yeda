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
    /* jsdom לא מספק fetch; מחזירים כישלון כדי שנתיבי ה-catch ירוצו */
    w.fetch = () => Promise.reject(new Error('אין רשת בבדיקה'));
    /* האפליקציה חסומה מאחורי התחברות — מזריקים מפגש כדי לבדוק את מה שמאחוריו */
    try { w.localStorage.setItem('shinun-auth',
      JSON.stringify({ access: 'smoke-token', refresh: 'smoke-refresh', email: 'smoke@test' })); } catch {}
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

/* 4 — נכונות מתזמן FSRS. לוח זמנים שגוי לא נראה שבור, ולכן נבדק במפורש. */
{
  const w = win.eval('typeof FSRS_W !== "undefined" ? FSRS_W : null');
  check(Array.isArray(w) && w.length === 21, 'וקטור המשקלים של FSRS חסר');

  const R = (S, t) => win.eval(`retrievability(${S}, ${t})`);
  /* בהגדרה, אחרי S ימים ההסתברות להיזכר היא בדיוק 0.9 */
  check(Math.abs(R(10, 10) - 0.9) < 1e-6, `R(S,S)=${R(10, 10)}, אמור להיות 0.9`);
  check(R(10, 0) === 1, 'R בזמן אפס אמור להיות 1');
  check(R(10, 40) < R(10, 10), 'שכחה אמורה לגדול עם הזמן');

  const rev = (st, g, now) => win.eval(
    `JSON.stringify(reviewCard(${JSON.stringify(st)}, ${g}, ${now}))`);
  const NOW = 1_760_000_000_000, DAY = 86400000;

  /* כרטיס חדש: ציון גבוה יותר צריך לתת אינטרוול ארוך יותר */
  const iv = [1, 2, 3, 4].map((g) => JSON.parse(rev(null, g, NOW)))
    .map((c) => Math.round((c.due - NOW) / DAY));
  check(iv[1] <= iv[2] && iv[2] <= iv[3], `אינטרוול לא עולה עם הציון: ${iv}`);
  check(iv[0] < 1, 'תשובה שגויה אמורה לחזור באותו יום');

  /* חזרה מוצלחת אחרי המתנה מגדילה יציבות; טעות מקטינה אותה */
  const seed = JSON.parse(rev(null, 3, NOW));
  const later = NOW + Math.round((seed.due - NOW) / DAY) * DAY;
  const good = JSON.parse(rev(seed, 3, later));
  const again = JSON.parse(rev(seed, 1, later));
  check(good.s > seed.s, `יציבות לא גדלה אחרי הצלחה: ${seed.s} → ${good.s}`);
  check(again.s < seed.s, `יציבות לא קטנה אחרי טעות: ${seed.s} → ${again.s}`);
  check(again.lapses === 1, 'טעות לא נספרה כ-lapse');
  check(good.d >= 1 && good.d <= 10, `קושי מחוץ לתחום: ${good.d}`);
  check(good.due > later, 'כרטיס שנענה נכון לא אמור להיות מיידית לחזרה');

  /* מיפוי מהירות לציון */
  const grade = (ok, ms) => win.eval(`gradeOf(${ok}, ${ms})`);
  check(grade(false, 1000) === 1, 'תשובה שגויה אמורה לקבל 1');
  check(grade(true, 2000) === 4, 'תשובה מהירה אמורה לקבל 4');
  check(grade(true, 8000) === 3, 'תשובה רגילה אמורה לקבל 3');
  check(grade(true, 20000) === 2, 'תשובה איטית אמורה לקבל 2');

  /* המתזמן מקדים כרטיס שהגיע זמנו על פני כרטיס שעוד לא */
  const order = win.eval(`(function(){
    CARDS['x-due']    = {s:5, d:5, due:Date.now()-86400000, last:Date.now()-6*86400000, reps:1, lapses:0};
    CARDS['x-future'] = {s:50, d:5, due:Date.now()+30*86400000, last:Date.now(), reps:3, lapses:0};
    const items = [{id:'future'},{id:'due'}];
    const out = pickWeighted(items, 2, function(i){ return 'x-' + i.id; });
    return out[0].id;
  })()`);
  check(order === 'due', 'המתזמן לא הקדים את הכרטיס שהגיע זמנו');
}

/* 5 — בלי מפגש שמור, מסך הנעילה מופיע ושום דבר אחר לא */
{
  const locked = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://shassaf.github.io/shinun-biochem/',
    virtualConsole: vc,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.scrollTo = () => {};
      w.fetch = () => Promise.reject(new Error('אין רשת בבדיקה'));
    },
  });
  await new Promise((r) => locked.window.addEventListener('load', r, { once: true }));
  const d = locked.window.document;
  const authOn = locked.window.eval('typeof authEnabled !== "undefined" ? authEnabled : false');
  if (authOn) {
    check(!!d.querySelector('.lock'), 'מסך הנעילה לא נרנדר ללא מפגש');
    check(!!d.querySelector('#lockGoogle'), 'אין כפתור התחברות עם גוגל');
    check(!d.querySelector('.deck-list'), 'התוכן דלף אל מסך הנעילה');
  }
  locked.window.close();
}

dom.window.close();

if (fail.length) {
  console.error('בדיקת העשן נכשלה:\n' + [...new Set(fail)].map((f) => '  · ' + f).join('\n'));
  process.exit(1);
}
console.log('בדיקת העשן עברה — %d חבילות, %d פריטים',
  DECKS.length, DECKS.reduce((a, d) => a + d.items.length, 0));
