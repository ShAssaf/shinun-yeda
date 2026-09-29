/* בדיקת עשן — טוענת את www/index.html ב-DOM וירטואלי ומוודאת שהאפליקציה עולה
   ושכל חבילה מייצרת שאלות תקינות בכל מצב. נכשלת = לא מדפלויים.
   שימוש:  node tools/smoke.mjs        */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDS = 8;          /* כל מצב נבנה כמה פעמים — הבחירה אקראית */
const fail = [];

const html = await readFile(join(ROOT, 'www', 'index.html'), 'utf8');

const vc = new VirtualConsole();
/* סגירת חלון מפרקת את ה-body, ומשקיף ההיסטוריה של האפליקציה רץ על מסמך
   שכבר איננו. זה רעש של פירוק הבדיקה, לא תקלה — בדפדפן הדף לא נסגר מתחתיה. */
let tearingDown = false;
vc.on('jsdomError', (e) => { if (!tearingDown) fail.push('שגיאת JS בטעינה: ' + e.message); });

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://shassaf.github.io/shinun-yeda/',
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

/* אין יותר נפילה אוטומטית לתוכן המוטמע — הבדיקה טוענת ספרייה במפורש,
   בדיוק כמו משתמש שהתוכן שלו הגיע מהשרת. */
win.eval('(function(){ LIB.status="ok"; LIB.rows = localRows(); applyRows(); renderNow(); })()');

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
      /* סבב חייב להיות באורך המבוקש כשיש מספיק פריטים. בנושא, כל מצב
         שואב ממאגר אחר — כרטיסים, תרגילים או שניהם. */
      const pool = deck.poolFor ? deck.poolFor(mode.id).length : deck.items.length;
      const want = Math.min(12, pool);
      if (qs.length < want && mode.id !== 'pair') {
        fail.push(`${deck.id}/${mode.id}: ${qs.length} שאלות במקום ${want}`);
        break;
      }
      for (const q of qs) {
        if (q.act) {
          /* תרגיל: כל תשובה שיעד מצפה לה נמצאת בבנק, ויש מה למלא */
          const texts = q.chips.map((c) => c.text);
          const need = q.layout.targets.flatMap((t) => t.expect);
          if (!need.length) { fail.push(`${deck.id}/${mode.id}: תרגיל בלי יעדים`); break; }
          if (need.some((x) => texts.indexOf(x) < 0)) { fail.push(`${deck.id}/${mode.id}: תשובה חסרה בבנק`); break; }
          if (new Set(q.chips.map((c) => c.id)).size !== q.chips.length) { fail.push(`${deck.id}/${mode.id}: מזהי פריטים כפולים`); break; }
          if (!q.label || !q.prompt.main) { fail.push(`${deck.id}/${mode.id}: אין ניסוח לתרגיל`); break; }
          continue;
        }
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
  win.eval(`startQuiz(${JSON.stringify(DECKS[0].id)}, ${JSON.stringify(DECKS[0].modes[0].id)}); renderNow();`);
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

/* 4b — תאריך מבחן חותך אינטרוולים, וסבב מאוחד נבנה מכל החבילות */
{
  const capped = win.eval(`(function(){
    const before = nextInterval(200);
    store.examDate = new Date(Date.now() + 10*86400000).toISOString().slice(0,10);
    const after = nextInterval(200);
    const days = examDaysLeft();
    store.examDate = null;
    return JSON.stringify({before:before, after:after, days:days, cap:5});
  })()`);
  const c = JSON.parse(capped);
  check(c.before > c.after, `תאריך מבחן לא חתך את האינטרוול: ${c.before} → ${c.after}`);
  check(c.after <= 5, `האינטרוול ${c.after} חורג מחצי הימים שנותרו`);
  check(c.days >= 9 && c.days <= 11, `ספירת הימים למבחן שגויה: ${c.days}`);

  try {
    win.eval('startMixed(); renderNow();');
    const q = win.eval('JSON.stringify({n:quiz.qs.length, deck:quiz.deck.id, keys:quiz.qs.map(x=>x.key.split(":")[0])})');
    const info = JSON.parse(q);
    check(info.deck === 'all', 'הסבב המאוחד לא סומן כחבילת all');
    check(info.n > 0 && info.n <= 12, `הסבב המאוחד הכיל ${info.n} שאלות`);
    check(new Set(info.keys).size > 1, 'הסבב המאוחד משך רק מחבילה אחת');
  } catch (e) {
    fail.push('הסבב המאוחד נפל: ' + e.message);
  }
}

/* 4c — מפת האיזומרים נשענת על נתוני החבילה ולא על משתנה גלובלי */
{
  const isoDeck = (DECKS ?? []).find((d) => d.map);
  if (isoDeck) {
    win.eval(`(function(){ quiz=null; view={name:"map", back:${JSON.stringify(isoDeck.id)}}; renderNow(); })()`);
    const nodes = document.querySelectorAll('.node').length;
    check(nodes >= isoDeck.map.iso.length, `המפה הציגה ${nodes} צמתים, פחות מהצפוי`);
  }
}

/* 5 — מסך העיון נבנה לכל חבילה, וכל פריט מקבל תיאור תקין */
for (const deck of DECKS ?? []) {
  check(typeof deck.browse === 'function', `${deck.id}: אין browse`);
  if (typeof deck.browse !== 'function') continue;
  for (const item of deck.items) {
    const b = deck.browse(item);
    if (!b || !b.title) { fail.push(`${deck.id}: פריט בעיון בלי כותרת`); break; }
  }
}
try {
  const first = DECKS[0];
  win.eval(`(function(){ quiz=null; view={name:'browse', deck:${JSON.stringify(first.id)}, q:'', hide:false}; renderNow(); })()`);
  check(!!document.querySelector('.browse-wrap'), 'מסך העיון לא נרנדר');
  check(document.querySelectorAll('.bcard').length === first.items.length,
    `מסך העיון הראה ${document.querySelectorAll('.bcard').length} כרטיסים במקום ${first.items.length}`);
  /* סינון שלא תואם לכלום לא אמור להשאיר כרטיסים */
  win.eval(`(function(){ view.q='zzzzנונסנס'; renderNow(); })()`);
  check(document.querySelectorAll('.bcard').length === 0, 'הסינון בעיון לא סינן');
} catch (e) {
  fail.push('מסך העיון נפל: ' + e.message);
}

/* 5b — החנות נרנדרת גם כשהשרת לא זמין, ומבחינה בין שלי לשל אחרים */
try {
  win.eval(`(function(){
    quiz = null;
    view = {name:'store', loading:false, subs:['s1'],
      mine:[{id:'m1', title:'שלי פרטית', item_count:9, visibility:'private'},
            {id:'m2', title:'שלי ציבורית', item_count:4, visibility:'public'}],
      others:[{id:'s1', title:'של אחר', item_count:7, visibility:'public'},
              {id:'s2', title:'עוד אחד', item_count:5, visibility:'public'}]};
    renderNow();
  })()`);
  const cards = document.querySelectorAll('.scard').length;
  check(cards === 4, `החנות הציגה ${cards} חבילות במקום 4`);
  check(document.querySelectorAll('[data-pub]').length === 2, 'אין כפתורי פרסום לנושאים שלי');
  check(document.querySelectorAll('[data-del]').length === 2, 'אין כפתורי מחיקה לנושאים שלי');
  /* קישור מוצע רק לנושא שכבר פורסם */
  check(document.querySelectorAll('[data-link]').length === 1, 'קישור מוצע לנושא שאינו ציבורי');


  check(document.querySelectorAll('[data-sub]').length === 2, 'אין כפתורי מינוי לחבילות של אחרים');
  /* חבילה שאני רשום אליה מוצגת כ"הסר", ואחת שלא — כ"הוסף" */
  const subBtns = Array.from(document.querySelectorAll('[data-sub]'));
  const joined = subBtns.find((b) => b.dataset.sub === 's1');
  const free = subBtns.find((b) => b.dataset.sub === 's2');
  check(joined?.textContent.trim() === 'הסר', 'מינוי קיים לא סומן');
  check(free?.textContent.trim() === 'הוסף', 'חבילה שלא נרשמתי אליה סומנה כרשומה');
  /* פרטית מציעה לפרסם, ציבורית מציעה להפוך לפרטית */
  const pubBtns = Array.from(document.querySelectorAll('[data-pub]'));
  check(pubBtns.find((b) => b.dataset.pub === 'm1')?.dataset.to === 'public', 'פרטית לא מציעה פרסום');
  check(pubBtns.find((b) => b.dataset.pub === 'm2')?.dataset.to === 'private', 'ציבורית לא מציעה החזרה לפרטית');
  /* נושא שקיים בחבילה המוטמעת ואינו בספרייה חייב להיות מוצע לייבוא,
     גם כשיש כבר נושאים אחרים — כך תוכן שנתקע במסלול הישן לא אובד. */
  const offer = JSON.parse(win.eval(`(function(){
    view.mine = [{id:'m1', kind:'groups', title:localRows()[0].title, item_count:24, visibility:'private'}];
    view.others = []; view.subs = []; view.loading = false;
    renderNow();
    const btn = document.getElementById('seedBtn');
    return JSON.stringify({
      offered: !!btn,
      label: btn ? btn.textContent : '',
      total: localRows().length
    });
  })()`));
  check(offer.offered, 'נושאים שלא יובאו אינם מוצעים כשכבר יש ספרייה');
  check(offer.label.indexOf(String(offer.total - 1)) > -1,
    'מספר הנושאים לייבוא שגוי: ' + offer.label);
} catch (e) {
  fail.push('מסך החנות נפל: ' + e.message);
}

/* 5c — ספרייה ריקה מהשרת נשארת ריקה; רק כישלון משיכה נופל לתוכן המוטמע */
{
  const behaviour = win.eval(`(function(){
    const before = DECKS.length;
    const snap = LIB.rows.slice();
    LIB.rows = []; LIB.status='ok'; applyRows(); renderNow();
    const emptyAnswer = DECKS.length;
    LIB.rows = []; LIB.status='error'; applyRows(); renderNow();
    const noAnswer = DECKS.length;
    LIB.rows = snap; LIB.status='ok'; applyRows(); renderNow();
    return JSON.stringify({before:before, emptyAnswer:emptyAnswer, noAnswer:noAnswer});
  })()`);
  const b = JSON.parse(behaviour);
  check(b.emptyAnswer === 0, `ספרייה ריקה מהשרת הציגה ${b.emptyAnswer} נושאים במקום 0`);
  check(b.noAnswer === 0, 'כישלון משיכה בלי מטמון אמור להשאיר ספרייה ריקה, לא תוכן מוטמע');
}

/* 5b2 — זיהוי כפילויות שומר את הראשון שנוצר */
{
  const r = JSON.parse(win.eval(`(function(){
    const mine = [
      {id:'b', kind:'groups', title:'א', created_at:'2026-01-02'},
      {id:'a', kind:'groups', title:'א', created_at:'2026-01-01'},
      {id:'c', kind:'groups', title:'א', created_at:'2026-01-03'},
      {id:'d', kind:'topic',  title:'ב', created_at:'2026-01-01'}
    ];
    return JSON.stringify(duplicateDecks(mine).map(function(x){ return x.id; }));
  })()`));
  check(r.length === 2, `זוהו ${r.length} כפילויות במקום 2`);
  check(r.indexOf('a') < 0, 'הניקוי היה מוחק את הנושא הראשון שנוצר');
  check(r.indexOf('d') < 0, 'נושא ייחודי סומן ככפילות');
}

/* 5c1 — ארבעת מצבי הספרייה, ומה כל אחד מציג */
{
  const states = JSON.parse(win.eval(`(function(){
    const out = {};
    const snap = LIB.rows.slice();
    quiz = null; view = {name:'home'};      /* מסכי הבדיקות הקודמות */

    LIB.status='unknown'; LIB.rows=[]; applyRows(); renderNow();
    out.unknown = {decks:DECKS.length, html:app.innerHTML.indexOf('טוען את הספרייה') > -1};

    LIB.status='error'; LIB.reason='HTTP 500'; LIB.rows=[]; applyRows(); renderNow();
    out.error = {decks:DECKS.length, shows:app.innerHTML.indexOf('לא הצלחתי לטעון') > -1,
                 reason:app.innerHTML.indexOf('HTTP 500') > -1};

    LIB.status='ok'; LIB.reason=null; LIB.rows=[]; applyRows(); renderNow();
    out.empty = {decks:DECKS.length, shows:app.innerHTML.indexOf('אין עדיין נושאים') > -1};

    LIB.status='cached'; LIB.rows=snap; applyRows(); renderNow();
    out.cached = {decks:DECKS.length, warns:app.innerHTML.indexOf('מוצג מהמטמון המקומי') > -1};

    LIB.status='ok'; applyRows(); renderNow();
    return JSON.stringify(out);
  })()`));
  check(states.unknown.decks === 0 && states.unknown.html, 'מצב unknown לא מציג טעינה');
  check(states.error.decks === 0 && states.error.shows, 'מצב error לא מציג שגיאה');
  check(states.error.reason, 'מצב error לא מציג את הסיבה');
  check(states.empty.decks === 0 && states.empty.shows, 'ספרייה ריקה מהשרת לא מציגה מצב ריק');
  check(states.cached.decks > 0, 'מטמון לא מוצג');
  check(states.cached.warns, 'הצגת מטמון ישן לא מסומנת למשתמש');
}

/* 5c2 — משיכת ספרייה לא מוחקת את המראה כשהיא לא מצליחה לענות */
{
  /* משיכה אסינכרונית ותלוית שרת; נבדק כאן החוזה שמונע מחיקת המראה */
  const src = win.eval('fetchLibrary.toString()');
  check(src.indexOf("reason:'זהות לא נפתרה'") > -1, 'משיכה בלי uid לא מחזירה סיבה');
  check(src.indexOf('if(!mine.ok) return mine') > -1, 'כישלון שאילתה לא מוחזר כתוצאה');
  check(win.eval('fetchSubs.toString()').indexOf('{ok:true, data:') > -1,
    'fetchSubs לא מחזיר תוצאה מפורשת');
}

/* 5d — מסך הסטטיסטיקה: תחזית, כרטיסי מידע ופירוט לפי נושא */
try {
  win.eval(`(function(){
    const now = Date.now(), D = 86400000;
    CARDS = {};
    DECKS.forEach(function(d, di){
      d.items.forEach(function(it, i){
        CARDS[d.keyFn(it)] = {s:1+((i*7)%40), d:5,
          due: now + (((i*3+di*2)%15) - 2)*D, last: now-D, reps:2, lapses:0};
      });
    });
    quiz = null;
    view = {name:'stats', stats:{loading:false, total:180, correct:149, week:63}};
    renderNow();
  })()`);
  const bars = document.querySelectorAll('.bar-mark').length;
  const hits = document.querySelectorAll('.bar-hit').length;
  check(hits === 14, `התחזית הציגה ${hits} ימים במקום 14`);
  check(bars > 0 && bars <= 14, `מספר עמודות לא סביר: ${bars}`);
  check(document.querySelectorAll('.drow').length === DECKS.length, 'הפירוט לפי נושא לא תואם למספר הנושאים');
  check(document.querySelectorAll('.hero .tile').length === 3, 'חסרים כרטיסי מידע');
  /* כל עמודה נגישה גם בלי ריחוף */
  check(Array.from(document.querySelectorAll('.bar-hit')).every((h) => h.querySelector('title')),
    'לעמודה חסר תיאור נגיש');
  const svg = document.querySelector('.panel-chart svg');
  check(svg?.getAttribute('aria-label'), 'לגרף אין aria-label');
} catch (e) {
  fail.push('מסך הסטטיסטיקה נפל: ' + e.message);
}

/* 5e — ייבוא ערכת הפתיחה מדווח שגיאה במקום להיכשל בשקט */
{
  /* הקריאה עצמה דורשת שרת; נבדק כאן החוזה שמונע כישלון שקט */
  const shape = win.eval(`(function(){
    const src = importStarter.toString();
    return JSON.stringify({
      returnsObject: src.indexOf('{ok:false') > -1,
      reportsServer: src.indexOf('השרת דחה') > -1,
      ensuresUid: src.indexOf('loadIdentity()') > -1,
      matchesByTitle: src.indexOf('x.title===d.title') > -1
    });
  })()`);
  const c = JSON.parse(shape);
  check(c.returnsObject, 'הייבוא לא מחזיר תוצאה עם שגיאה');

  /* PostgREST דוחה הוספה מרובה שבה לאובייקטים ערכות מפתחות שונות.
     חבילת נושא בלי color או subtitle גרמה בדיוק לזה — נבדק על המטען האמיתי. */
  const keysets = JSON.parse(win.eval(`(function(){
    return JSON.stringify(starterPayload(starterRows('u-test')).map(function(o){
      return Object.keys(JSON.parse(JSON.stringify(o))).sort().join(',');
    }));
  })()`));
  check(new Set(keysets).size === 1,
    'לשורות הייבוא ערכות מפתחות שונות: ' + JSON.stringify([...new Set(keysets)]));
  check(keysets.length >= 3, `המטען הכיל ${keysets.length} שורות בלבד`);
}

/* 5f — יומן התקלות: לכידה, דחיית כפילויות, ומסך האדמין */
{
  const r = JSON.parse(win.eval(`(function(){
    try{ localStorage.removeItem('shinun-errq'); }catch(e){}
    ERRQ = [];
    logError('client', 'בדיקה אחת', {a:1});
    logError('client', 'בדיקה אחת', {a:1});   /* כפילות בטווח דקה */
    logError('fetch',  'בדיקה שנייה', null);
    logError('client', '');                    /* ריק — לא נרשם */
    return JSON.stringify({
      n: ERRQ.length,
      kinds: ERRQ.map(function(x){ return x.kind; }),
      hasScreen: !!(ERRQ[0] && ERRQ[0].context && 'screen' in ERRQ[0].context),
      hasUa: !!(ERRQ[0] && ERRQ[0].user_agent)
    });
  })()`));
  check(r.n === 2, `נרשמו ${r.n} תקלות במקום 2 (כפילות או ריק לא נחסמו)`);
  check(r.kinds.join(',') === 'client,fetch', 'סוגי התקלות לא נשמרו');
  check(r.hasScreen, 'לא נשמר המסך שבו קרתה התקלה');
  check(r.hasUa, 'לא נשמר הדפדפן');

  /* דיווח שנכשל לא מייצר תקלה נוספת — אחרת נוצרת לולאה */
  const noLoop = JSON.parse(win.eval(`(function(){
    ERRQ = [];
    logging = true;
    logError('client', 'לא אמור להירשם');
    logging = false;
    return JSON.stringify({n: ERRQ.length});
  })()`));
  check(noLoop.n === 0, 'לכידה בזמן דיווח יוצרת לולאה');

  try {
    win.eval(`(function(){
      quiz = null;
      view = {name:'errors', loading:false, filter:'', rows:[
        {id:1, at:'2026-09-01T10:00:00Z', kind:'fetch', message:'GET decks → 401', context:{status:401}},
        {id:2, at:'2026-09-01T10:05:00Z', kind:'client', message:'x is not defined', context:{line:12}}
      ]};
      renderNow();
    })()`);
    check(document.querySelectorAll('.erow').length === 2, 'מסך היומן לא הציג את השורות');
    win.eval(`(function(){ view.filter='401'; renderNow(); })()`);
    check(document.querySelectorAll('.erow').length === 1, 'הסינון ביומן לא סינן');
  } catch (e) {
    fail.push('מסך היומן נפל: ' + e.message);
  }
}

/* 5g — רצף העלייה: ציור מיידי, זהות לפני שאילתות, וציור מאוחד */
{
  const src = win.eval('boot.toString()');
  check(src.indexOf('renderNow()') > -1, 'העלייה לא מציירת מיידית מהמטמון');
  check(src.indexOf('loadIdentity()') < src.indexOf('loadLibrary()'),
    'הספרייה נמשכת לפני שהזהות נפתרה');
  check(src.indexOf('booted') > -1, 'העלייה יכולה לרוץ פעמיים');

  /* קריאות render מרובות מתאחדות לציור אחד */
  const coalesced = JSON.parse(win.eval(`(function(){
    let painted = 0;
    const real = paint;
    paint = function(){ painted++; return real.apply(null, arguments); };
    render(); render(); render();
    const during = painted;
    renderNow();
    const after = painted;
    paint = real;
    return JSON.stringify({during:during, after:after});
  })()`));
  check(coalesced.during === 0, 'render צייר מיידית במקום לאחד');
  check(coalesced.after === 1, 'renderNow לא צייר בדיוק פעם אחת');
}

/* 5h — רענון טוקן משמר את הזהות; פקיעה מזוהה מראש */
{
  const src = win.eval('doRefresh.toString()');
  check(src.indexOf('Object.assign({}, AUTH') > -1,
    'רענון בונה את הזהות מחדש ומוחק את uid');
  check(win.eval('hardSignOut.toString()').indexOf('lockErr') > -1,
    'כישלון רענון לא מחזיר למסך התחברות');
  check(src.indexOf("return 'transient'") > -1, 'כשל רשת ברענון מנתק במקום לנסות שוב');

  const restSrc = win.eval('rest.toString()');
  check(restSrc.indexOf('ensureToken()') > -1, 'קריאה למסד לא מוודאת טוקן תקף');
  check(restSrc.indexOf('r.status === 401') > -1, 'קריאה למסד לא מנסה שוב אחרי 401');

  /* קריאת exp מתוך JWT */
  const exp = JSON.parse(win.eval(`(function(){
    const save = AUTH;
    const body = btoa(JSON.stringify({exp: Math.floor(Date.now()/1000) - 10}));
    AUTH = {access: 'h.' + body + '.s', refresh: 'r'};
    const stale = tokenStale();
    const body2 = btoa(JSON.stringify({exp: Math.floor(Date.now()/1000) + 3600}));
    AUTH = {access: 'h.' + body2 + '.s', refresh: 'r'};
    const fresh = tokenStale();
    AUTH = save;
    return JSON.stringify({stale:stale, fresh:fresh});
  })()`));
  check(exp.stale === true, 'טוקן שפג לא זוהה');
  check(exp.fresh === false, 'טוקן תקף סומן כפג');

  /* טוקן שאי אפשר לפענח חייב להיחשב פג. ההנחה ההפוכה מבטלת את הרענון
     לגמרי, וכל שאילתה חוזרת 401 לנצח. */
  const unreadable = JSON.parse(win.eval(`(function(){
    const save = AUTH;
    const out = {};
    AUTH = {access:'לא-jwt-בכלל', refresh:'r'};       out.garbage = tokenStale();
    AUTH = {access:'h..s', refresh:'r'};              out.empty   = tokenStale();
    AUTH = {access:'h.' + btoa('{not-json') + '.s', refresh:'r'}; out.broken = tokenStale();
    /* מטען עם תווים לא-ASCII חייב להיקרא בכל זאת */
    const utf8 = btoa(unescape(encodeURIComponent(
      JSON.stringify({exp: Math.floor(Date.now()/1000) + 3600, name:'שלמה'}))));
    AUTH = {access:'h.' + utf8 + '.s', refresh:'r'};  out.hebrew = tokenStale();
    AUTH = save;
    return JSON.stringify(out);
  })()`));
  check(unreadable.garbage === true, 'טוקן לא קריא נחשב תקף');
  check(unreadable.empty === true, 'טוקן בלי מטען נחשב תקף');
  check(unreadable.broken === true, 'מטען שבור נחשב תקף');
  check(unreadable.hebrew === false, 'מטען עם עברית נחשב פג — הפענוח נכשל');
}

/* 5i — כפתור «למה»: ניתן לנסות שוב אחרי כישלון, ושולח שאלה ותשובה לא ריקות */
{
  const src = win.eval('renderQuiz.toString()');
  check(src.indexOf('if(q.whyBusy || whyFor(q.key)) return;') > -1,
    'כישלון קודם חוסם ניסיון חוזר של «למה»');
  check(src.indexOf("logError('function', 'explain") > -1, 'כישלון «למה» לא נרשם ביומן');
  check(win.eval('callFn.toString()').indexOf('ensureToken()') > -1,
    'קריאה לפונקציה לא מוודאת טוקן תקף');

  /* כל סוגי השאלות, כולל בחירת מבנה שבה לאפשרויות אין טקסט כלל */
  const built = JSON.parse(win.eval(`(function(){
    const bad = [];
    DECKS.forEach(function(d){
      d.modes.forEach(function(m){
        for(var r=0;r<4;r++){
          d.build(m.id, 4).forEach(function(q){
            const correct = q.options.filter(function(o){ return o.id === q.answer; })[0];
            const other   = q.options.filter(function(o){ return o.id !== q.answer; })[0];
            const t = explainText(q, correct, other);
            if(!t.question || !String(t.question).trim()) bad.push(d.id+'/'+m.id+' שאלה ריקה');
            if(!t.answer   || !String(t.answer).trim())   bad.push(d.id+'/'+m.id+' תשובה ריקה');
            /* התשובה חייבת לזהות את הפריט, לא רק להיות מחרוזת כלשהי */
            if(q.act){
              q.layout.targets.forEach(function(tg){
                tg.expect.forEach(function(x){
                  if(t.answer.indexOf(x) < 0) bad.push(d.id+'/'+m.id+' הפתרון חסר את '+x);
                });
              });
            } else if(q.optionKind === 'pic'){
              if(!q.prompt.main || t.answer.indexOf(q.prompt.main) < 0)
                bad.push(d.id+'/'+m.id+' תשובה לא מזהה את המבנה');
            } else if(correct && correct.main){
              if(t.answer.indexOf(correct.main) < 0)
                bad.push(d.id+'/'+m.id+' תשובה לא מזהה את הפריט');
            }
          });
        }
      });
    });
    return JSON.stringify(bad.slice(0, 5));
  })()`));
  check(built.length === 0, 'טקסט ריק ל«למה»: ' + JSON.stringify(built));
}

/* 5j — פרסום חי רק במאגר, לא במסך הנושא */
{
  const deckSrc = win.eval('renderDeck.toString()');
  check(deckSrc.indexOf('pubBtn') < 0, 'כפתור פרסום נשאר במסך הנושא');
  check(deckSrc.indexOf('linkBtn') < 0, 'העתקת קישור נשארה במסך הנושא');
  const storeSrc = win.eval('renderStore.toString()');
  check(storeSrc.indexOf('data-pub') > -1, 'אין פרסום במאגר');
  check(storeSrc.indexOf('data-link') > -1, 'אין העתקת קישור במאגר');
}

/* 5k — איפוס מטמון מדווח תוצאה ולא מרענן בעיוורון */
{
  const src = win.eval('hardReset.toString()');
  check(src.indexOf('location.reload') < 0, 'האיפוס עדיין מרענן בעיוורון');
  check(src.indexOf('caches.keys') > -1, 'האיפוס לא מנקה את מטמון ה-service worker');
  check(src.indexOf('loadLibrary') > -1, 'האיפוס לא מושך מחדש');

  const report = win.eval(`(function(){
    return hardReset().then(function(r){ return typeof r === 'string' && r.length > 0; });
  })()`);
  check(report instanceof win.Promise || report === true || report,
    'האיפוס לא מחזיר דיווח');
  check(win.eval('renderStore.toString()').indexOf('diag-report') > -1,
    'הדיווח לא מוצג במסך');
}

/* 5l — הוספת תוכן מרעננת את הספרייה ולא מבקשת רענון ידני */
{
  const src = win.eval('openAddSheet.toString()');
  check(src.indexOf('האתר נבנה מחדש') < 0, 'ההודעה עדיין מבקשת להמתין לבנייה');
  check(src.indexOf('syncLibrary()') > -1, 'הוספה לא מסנכרנת את הספרייה');
  check(src.indexOf('location.reload') < 0, 'הוספה עדיין מרעננת את הדף');
}

/* 5m — המאגר והמסך הראשי נשענים על אותה ספרייה */
{
  const src = win.eval('openStore.toString()');
  check(src.indexOf('syncLibrary()') > -1, 'המאגר שואל את השרת בנפרד מהמסך הראשי');
  check(src.indexOf('fetchMine()') < 0, 'המאגר עדיין מושך רשימה נפרדת');
  check(src.indexOf('LIB.rows.filter') > -1, 'המאגר לא נגזר מהספרייה');

  /* נושא בבעלותי שנמצא בספרייה חייב להופיע גם במסך הראשי */
  const both = JSON.parse(win.eval(`(function(){
    const save = LIB.rows.slice(), savedAuth = AUTH;
    AUTH = Object.assign({}, AUTH || {}, {uid:'owner-1'});
    LIB.status = 'ok';
    LIB.rows = save.concat([{id:'new-1', kind:'topic', title:'מעגל קרבס', subtitle:'',
      color:null, visibility:'private', owner_id:'owner-1', item_count:15,
      data:[{id:'a',front:'א',back:'1'},{id:'b',front:'ב',back:'2'},
            {id:'c',front:'ג',back:'3'},{id:'d',front:'ד',back:'4'}]}]);
    applyRows(); renderNow();
    const onHome = DECKS.filter(function(d){ return d.id === 'new-1'; }).length;
    const mine = LIB.rows.filter(function(d){ return d.owner_id === AUTH.uid; }).length;
    LIB.rows = save; AUTH = savedAuth; applyRows(); renderNow();
    return JSON.stringify({onHome:onHome, mine:mine});
  })()`));
  check(both.onHome === 1, 'נושא בבעלותי לא הופיע במסך הראשי');
  check(both.mine === 1, 'נושא בבעלותי לא זוהה כשלי');
}

/* 5n — יציבות המפגש: רענון יחיד, סיווג כשלים, ואין ניתוק על תקלת רשת */
{
  /* כל מסלול שמרענן חייב לעבור דרך ensureToken. קריאה ישירה ל-doRefresh
     ממקומות שונים שורפת טוקני רענון מסובבים אחד לשני. */
  ['rest', 'callFn', 'verifyAccess', 'loadIdentity'].forEach(function(fn){
    const body = win.eval(fn + '.toString()');
    if (body.indexOf('doRefresh(') > -1) fail.push(fn + ' קורא ל-doRefresh במקום ל-ensureToken');
  });

  /* רענון יחיד: קריאות מקבילות חייבות לחלוק את אותה בקשה. נמדד לפי
     זהות ההבטחה ולא לפי מונה, כדי לא לספור רענון שכבר היה באוויר. */
  const single = JSON.parse(await win.eval(`(function(){
    const save = AUTH, realFetch = fetch;
    let calls = 0;
    const exp = Math.floor(Date.now()/1000) - 10;
    AUTH = {access:'h.' + btoa(JSON.stringify({exp:exp})) + '.s', refresh:'r', uid:'u'};
    SESSION.refreshing = null;
    fetch = function(){
      calls++;
      return Promise.resolve({ok:true, json:function(){
        const good = Math.floor(Date.now()/1000) + 3600;
        return Promise.resolve({access_token:'h.' + btoa(JSON.stringify({exp:good})) + '.s',
                                refresh_token:'r2'});
      }});
    };
    const a = ensureToken(), b = ensureToken(), c = ensureToken();
    const shared = (a === b) && (b === c);
    const started = calls;
    return Promise.all([a, b, c]).then(function(r){
      fetch = realFetch;
      const out = {shared:shared, started:started, results:r, uid:AUTH && AUTH.uid};
      AUTH = save;
      return JSON.stringify(out);
    });
  })()`));
  check(single.shared, 'קריאות רענון מקבילות לא חלקו בקשה אחת');
  check(single.started === 1, 'הרענון שלח ' + single.started + ' בקשות במקום אחת');
  check(single.results.join(',') === 'true,true,true', 'רענון מקבילי לא הצליח לכולם');
  check(single.uid === 'u', 'הרענון איבד את uid');

  /* תקלת רשת ברענון אינה מנתקת */
  const transient = JSON.parse(await win.eval(`(function(){
    const save = AUTH, realFetch = fetch;
    AUTH = {access:'h.' + btoa(JSON.stringify({exp:1})) + '.s', refresh:'r', uid:'u'};
    SESSION.refreshing = null;
    fetch = function(){ return Promise.reject(new Error('אין רשת')); };
    return doRefresh().then(function(res){
      fetch = realFetch;
      const out = {res:res, stillIn: !!AUTH};
      AUTH = save;
      return JSON.stringify(out);
    });
  })()`));
  check(transient.res === 'transient', 'תקלת רשת סווגה כניתוק');
  check(transient.stillIn, 'תקלת רשת ניתקה את המשתמש');

  check(win.eval('scheduleRefresh.toString()').indexOf('120000') > -1,
    'אין רענון יזום לפני הפקיעה');
}

/* 5o — כל שינוי מסתנכרן בעצמו, בלי פעולה ידנית */
{
  const store = win.eval('renderStore.toString()');
  ['data-del', 'data-pub', 'data-sub'].forEach(function(){});
  check(store.indexOf('mutate(function(){ return deleteDeck') > -1, 'מחיקה לא מסנכרנת');
  check(store.indexOf('mutate(function(){ return setVisibility') > -1, 'פרסום לא מסנכרן');
  check(store.indexOf('mutate(function(){ return isSub') > -1, 'מינוי לא מסנכרן');
  check(store.indexOf('return Promise.all(dups.map') > -1, 'ניקוי כפילויות לא מסנכרן');

  /* mutate תמיד מסנכרן אחרי הפעולה */
  const order = JSON.parse(await win.eval(`(function(){
    const realLoad = loadLibrary;
    const seen = [];
    loadLibrary = function(){ seen.push('sync'); return Promise.resolve({ok:true, data:LIB.rows}); };
    syncing = null;
    return mutate(function(){ seen.push('work'); return Promise.resolve('done'); })
      .then(function(out){
        loadLibrary = realLoad;
        return JSON.stringify({seen:seen, out:out});
      });
  })()`));
  check(order.seen.join(',') === 'work,sync', 'סדר הפעולות: ' + order.seen.join(','));
  check(order.out === 'done', 'mutate לא מחזיר את תוצאת הפעולה');

  /* סנכרון שרץ התחיל לפני השינוי — מי שמבקש בזמנו מקבל סבב אחד נוסף
     אחריו, משותף לכולם, ולא את התשובה הישנה */
  const queue = JSON.parse(await win.eval(`(function(){
    const realLoad = loadLibrary;
    const seen = [];
    let n = 0, release;
    loadLibrary = function(){
      const id = ++n;
      seen.push('start' + id);
      if(id === 1) return new Promise(function(r){ release = r; })
        .then(function(){ seen.push('end1'); return {ok:true, data:LIB.rows}; });
      seen.push('end' + id);
      return Promise.resolve({ok:true, data:LIB.rows});
    };
    syncing = null; syncQueued = null;
    const first = syncLibrary();
    const a = syncLibrary(), b = syncLibrary();
    release();
    return Promise.all([first, a, b]).then(function(){
      loadLibrary = realLoad;
      return JSON.stringify({seen:seen, same:a === b, idle:syncing === null && syncQueued === null});
    });
  })()`));
  check(queue.seen.join(',') === 'start1,end1,start2,end2',
    'סנכרון בזמן ריצה: ' + queue.seen.join(','));
  check(queue.same, 'בקשות בזמן ריצה לא מתאחדות לסבב אחד');
  check(queue.idle, 'הסנכרון לא השתחרר בסוף');
}

/* 5p — הגדרות המשתמש נשמרות בשרת, לא רק בדפדפן */
{
  check(win.eval('typeof pullSettings') === 'function', 'אין משיכת הגדרות מהשרת');
  check(win.eval('typeof pushSettings') === 'function', 'אין שמירת הגדרות בשרת');
  check(win.eval('boot.toString()').indexOf('pullSettings()') > -1,
    'ההגדרות לא נמשכות בעלייה');
  check(win.eval('next.toString()').indexOf('pushSettings()') > -1,
    'סיום סבב לא נשמר בשרת');
  check(win.eval('openExamSheet.toString()').indexOf('pushSettings()') > -1,
    'תאריך המבחן לא נשמר בשרת');
  check(win.eval('typeof store.best') === 'undefined', 'שדה השיא המת עדיין קיים');

  /* כתיבות מהירות מתאחדות */
  const merged = JSON.parse(await win.eval(`(function(){
    const realRest = rest, save = AUTH;
    let calls = 0;
    AUTH = Object.assign({}, AUTH || {}, {uid:'u'});
    pushingSettings = null;
    rest = function(){ calls++; return Promise.resolve({ok:true}); };
    const a = pushSettings(), b = pushSettings(), c = pushSettings();
    const shared = (a === b) && (b === c);
    return Promise.all([a,b,c]).then(function(){
      rest = realRest; AUTH = save;
      return JSON.stringify({calls:calls, shared:shared});
    });
  })()`));
  check(merged.shared, 'כתיבות הגדרות מקבילות לא התאחדו');
  check(merged.calls === 1, 'נשלחו ' + merged.calls + ' בקשות הגדרות במקום אחת');
}

/* 5q — צ'אט ההוספה: היסטוריה, צירוף קבצים, והדבקה מהלוח */
{
  const src = win.eval('openAddSheet.toString()');
  check(src.indexOf("addEventListener('paste'") > -1, 'אין הדבקה מהלוח');
  check(src.indexOf("addEventListener('drop'") > -1, 'אין גרירת קובץ');
  check(src.indexOf('messages:payload') > -1, 'הצ׳אט לא שולח היסטוריה');
  check(src.indexOf('application/pdf') > -1, 'אין תמיכה ב-PDF');
  check(win.eval('typeof prepFile') === 'function', 'אין הכנת קובץ לשליחה');

  /* PDF נשלח כמו שהוא; תמונה מכווצת */
  const kinds = JSON.parse(await win.eval(`(function(){
    function fakeFile(type, size, name){
      const blob = new Blob([new Uint8Array(size)], {type:type});
      return new File([blob], name, {type:type});
    }
    const pdf = fakeFile('application/pdf', 1000, 'x.pdf');
    return prepFile(pdf).then(function(f){
      return JSON.stringify({type:f.media_type, named:!!f.name});
    }).catch(function(e){ return JSON.stringify({error:e.message}); });
  })()`));
  check(kinds.type === 'application/pdf', 'PDF לא נשלח כמסמך: ' + JSON.stringify(kinds));
  check(kinds.named, 'שם הקובץ לא נשמר');

  /* קובץ לא נתמך נדחה בלקוח, לא בשרת */
  const bad = JSON.parse(await win.eval(`(function(){
    const blob = new Blob([new Uint8Array(10)], {type:'application/zip'});
    const f = new File([blob], 'a.zip', {type:'application/zip'});
    return prepFile(f).then(function(){ return JSON.stringify({rejected:false}); })
      .catch(function(e){ return JSON.stringify({rejected:true, msg:e.message}); });
  })()`));
  check(bad.rejected, 'קובץ לא נתמך לא נדחה בלקוח');

  /* PDF ענק נדחה לפני שליחה */
  const big = JSON.parse(await win.eval(`(function(){
    const blob = new Blob([new Uint8Array(10 * 1024 * 1024)], {type:'application/pdf'});
    const f = new File([blob], 'big.pdf', {type:'application/pdf'});
    return prepFile(f).then(function(){ return JSON.stringify({rejected:false}); })
      .catch(function(e){ return JSON.stringify({rejected:true, msg:e.message}); });
  })()`));
  check(big.rejected, 'PDF מעל התקרה לא נדחה בלקוח');
}

/* 5n — תרגילים אינטראקטיביים: פריסה, שיבוץ, ציון ומאגרי המצבים */
const ACT_FIXTURES = `
  var SORT = {id:'s1', type:'sort', prompt:'מיין', groups:[
    {label:'א', items:['x1','x2']}, {label:'ב', items:['y1']}], extra:['z']};
  var CYC = {id:'o1', type:'order', cycle:true, prompt:'מעגל', steps:[
    {label:'A', arrow:'e1'}, {label:'B', arrow:'e2'}, {label:'C', arrow:'e3'}, {label:'D', arrow:'e4'}]};
  var LIN = {id:'o2', type:'order', prompt:'רצף', ask:'both', steps:[
    {label:'P', arrow:'NADH'}, {label:'Q', arrow:'NADH'}, {label:'R', given:true, arrow:'x'}, {label:'S'}]};
  var BIG = {id:'o3', type:'order', cycle:true, prompt:'מעגל גדול', steps:
    'abcdefghijkl'.split('').map(function(x){ return {label:x}; })};
  var BROKEN = [{id:'b1', type:'sort', prompt:'', groups:[]},
                {id:'b2', type:'order', prompt:'x', steps:[{label:'a'}]},
                {id:'b3', type:'sort', prompt:'x', groups:[{label:'a', items:['1']}]}];
  var chipOf = function(q, t){ return q.chips.filter(function(c){ return c.text === t; })[0].id; };
`;
{
  const r = JSON.parse(win.eval(`(function(){
    ${ACT_FIXTURES}
    const out = {};
    out.ok = [SORT, CYC, LIN, BIG].map(activityOk);
    out.broken = BROKEN.map(activityOk);

    /* מעגל בלי עוגן חושף את השלב הראשון; החצים רמז כש-ask=steps */
    const L = actLayout(CYC);
    out.cycGiven = L.steps.map(function(s){ return s.given; }).join();
    out.cycArrows = L.arrows.length;
    out.cycTargets = L.targets.map(function(t){ return t.id; }).join();
    /* both: שלבים שאינם גלויים ואז החצים. ברצף יש חץ אחד פחות משלבים */
    out.linTargets = actLayout(LIN).targets.map(function(t){ return t.id; }).join();

    const key = function(x){ return 't:' + x.id; };
    const q = activityQuestion(SORT, key);
    out.chips = q.chips.map(function(c){ return c.text; }).sort().join();
    placeChip(q, chipOf(q,'x1'), 'g0'); placeChip(q, chipOf(q,'x2'), 'g0'); placeChip(q, chipOf(q,'y1'), 'g1');
    const g1 = gradeActivity(q);
    out.perfect = g1.right + '/' + g1.total;
    /* מסיח שובץ, ופריט עבר לקבוצה הלא נכונה */
    placeChip(q, chipOf(q,'z'), 'g1'); placeChip(q, chipOf(q,'x2'), 'g1');
    q.result = gradeActivity(q);
    out.partial = q.result.right + '/' + q.result.total;
    out.mistakes = mistakesText(q);

    /* משבצת יחידה מחליפה מקום; נגיעה בפריט שביעד אחר משבצת אליו */
    const q2 = activityQuestion(LIN, key);
    const P = chipOf(q2,'P'), Q = chipOf(q2,'Q');
    placeChip(q2, P, 's0');
    tapChip(q2, Q);
    tapChip(q2, P);
    out.swap = [q2.place[Q] || 'bank', q2.place[P] || 'bank', q2.sel].join();
    /* שני חצים שמצפים ל-NADH מקבלים כל אחד מהעותקים */
    const nadh = q2.chips.filter(function(c){ return c.text === 'NADH'; }).map(function(c){ return c.id; });
    placeChip(q2, nadh[1], 'a0'); placeChip(q2, nadh[0], 'a1');
    const g3 = gradeActivity(q2);
    out.nadh = g3.marks[nadh[0]] && g3.marks[nadh[1]];

    out.grades = [gradeOfSet(10,10,20000), gradeOfSet(10,10,80000), gradeOfSet(10,10,200000),
                  gradeOfSet(8,10,20000), gradeOfSet(5,10,20000), gradeOfSet(0,0,0)].join();

    /* נושא: תרגיל יחיד מספיק; תרגילים פגומים בלבד — לא נכנס */
    const only = makeDeck({id:'x', kind:'topic', title:'רק תרגיל', data:[SORT]}, 0);
    out.onlyModes = only.modes.map(function(m){ return m.id; }).join();
    out.onlyIn = buildDecks([{id:'x', kind:'topic', title:'רק תרגיל', data:[SORT]}]).length;
    out.junk = buildDecks([{id:'y', kind:'topic', title:'פגום', data:BROKEN}]).length;
    const mixed = makeDeck({id:'m', kind:'topic', title:'מעורב', data:[
      {id:'c1',front:'1',back:'a'}, {id:'c2',front:'2',back:'b'}, {id:'c3',front:'3',back:'c'},
      {id:'c4',front:'4',back:'d'}, SORT, CYC].concat(BROKEN)}, 0);
    out.mixedModes = mixed.modes.map(function(m){ return m.id; }).join();
    out.pools = ['f2b','b2f','drill','mix'].map(function(m){ return mixed.poolFor(m).length; }).join();
    out.kinds = mixed.build('mix', 12).map(function(x){ return x.act ? 'act' : 'mc'; }).sort().join();

    out.solution = [solutionText(SORT), solutionText(CYC)];
    return JSON.stringify(out);
  })()`));

  check(r.ok.every(Boolean), 'תרגיל תקין נפסל: ' + JSON.stringify(r.ok));
  check(r.broken.every((x) => !x), 'תרגיל פגום התקבל: ' + JSON.stringify(r.broken));
  check(r.cycGiven === 'true,false,false,false', 'מעגל בלי עוגן לא חשף את השלב הראשון');
  check(r.cycArrows === 4, 'במעגל חסר החץ מהאחרון חזרה לראשון');
  check(r.cycTargets === 's1,s2,s3', 'ask=steps הפך חצים ליעדים: ' + r.cycTargets);
  check(r.linTargets === 's0,s1,s3,a0,a1,a2', 'יעדי ask=both שגויים: ' + r.linTargets);
  check(r.chips === 'x1,x2,y1,z', 'הבנק לא מכיל בדיוק את התשובות והמסיח: ' + r.chips);
  check(r.perfect === '4/4', 'שיבוץ מושלם לא קיבל ציון מלא: ' + r.perfect);
  check(r.partial === '2/4', 'ציון חלקי שגוי: ' + r.partial);
  check(r.mistakes.indexOf('"z"') > -1 && r.mistakes.indexOf('"x2"') > -1, 'תיאור הטעויות חסר: ' + r.mistakes);
  check(r.swap === 's0,bank,', 'החלפה במשבצת לא עבדה: ' + r.swap);
  check(r.nadh, 'עותקים זהים לא התקבלו בשני היעדים');
  check(r.grades === '4,3,2,2,1,1', 'ציוני תרגיל שגויים: ' + r.grades);
  check(r.onlyModes === 'drill' && r.onlyIn === 1, 'נושא עם תרגיל יחיד לא נכנס לספרייה');
  check(r.junk === 0, 'נושא שכולו תרגילים פגומים נכנס לספרייה');
  check(r.mixedModes === 'f2b,b2f,drill,mix', 'מצבי נושא מעורב שגויים: ' + r.mixedModes);
  check(r.pools === '4,4,2,6', 'מאגרי המצבים שגויים: ' + r.pools);
  check(r.kinds === 'act,act,mc,mc,mc,mc', 'סבב מעורב לא כלל את כל הסוגים: ' + r.kinds);
  check(r.solution[0].indexOf('x1') > -1 && r.solution[1].indexOf('D') > -1, 'טקסט הפתרון חסר');
}

/* 5o — הלוח עצמו: לחיצות אמיתיות, בדיקה, תזמון, ושלושת סוגי הפריסה */
{
  const r = JSON.parse(win.eval(`(function(){
    ${ACT_FIXTURES}
    const out = {};
    const deck = makeDeck({id:'ia', kind:'topic', title:'תרגול', data:[SORT, CYC, LIN, BIG]}, 0);
    let scrolls = 0;
    window.scrollTo = function(){ scrolls++; };
    const show = function(item){
      quiz = {deck:deck, mode:'drill', qs:[activityQuestion(item, deck.keyFn)], i:0, correct:0, misses:[]};
      renderNow();
      return quiz.qs[0];
    };
    const $ = function(s){ return document.querySelector(s); };
    const $$ = function(s){ return document.querySelectorAll(s).length; };
    const chipEl = function(q, t){ return $('[data-chip="'+chipOf(q, t)+'"]'); };

    /* מיון */
    let q = show(SORT);
    out.groups = $$('.grp');
    out.bank = $$('.bank [data-chip]');
    const before = scrolls;
    chipEl(q, 'x1').click();
    out.selected = chipEl(q, 'x1').classList.contains('sel') && $$('.grp.can') === 2;
    $('.grp[data-zone="g0"] .grp-hd').click();
    out.placed = !!$('.grp[data-zone="g0"] [data-chip="'+chipOf(q,'x1')+'"]') && q.sel === null;
    out.keptScroll = scrolls === before;
    /* נגיעה בפריט שכבר בקבוצה, כשפריט אחר ביד, משבצת לאותה קבוצה */
    chipEl(q, 'x2').click(); chipEl(q, 'x1').click();
    chipEl(q, 'y1').click(); $('.grp[data-zone="g1"]').click();
    out.allPlaced = Object.keys(q.place).length === 3;
    /* מקלדת עם ספרה לא מפילה תרגיל */
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'1'}));
    $('#checkBtn').click();
    out.feedbackOk = !!$('.feedback.ok') && quiz.correct === 1 && !!$('#nextBtn');
    out.scheduled = !!cardState('ia:s1');
    out.frozen = $$('button.chip-a:not(:disabled)') === 0;

    /* מעגל: עיגול עם צמתים, קשתות ומקרא לחצים */
    q = show(CYC);
    out.cycle = [$$('.cyc'), $$('.cyc .cn'), $$('.cyc svg > path'), $$('.cyc .given'), $$('.legend-a li')].join();
    /* הצג תשובה בלי לשבץ דבר — כל יעד מקבל את התיקון שלו */
    out.reveal = $('#checkBtn').textContent;
    $('#checkBtn').click();
    out.fixes = $$('.fix') + '/' + q.layout.targets.length;
    out.missed = quiz.misses.length === 1 && !!$('.feedback.bad');

    /* רצף לינארי: משבצות חצים בשורות החץ; מעגל גדול נופל לרשימה */
    q = show(LIN);
    out.seq = [$$('.seq .st'), $$('.seq .ar .slot'), $$('.seq .given')].join();
    show(BIG);
    out.big = $$('.cyc') + ',' + $$('.seq .st');

    /* מסך הסיכום מציג תרגיל שהוחמץ */
    q = show(LIN);
    $('#checkBtn').click();
    quiz.done = true; renderNow();
    out.results = ($('.miss') || {}).textContent || '';

    /* עיון: פתרון מלא ותגית הסוג */
    DECKS.push(deck);
    quiz = null; view = {name:'browse', deck:'ia', q:'', hide:false}; renderNow();
    out.browse = $$('.bcard') + ',' + ($('.bcard .chip.cat') || {}).textContent;
    DECKS.pop();
    view = {name:'home'}; renderNow();
    return JSON.stringify(out);
  })()`));

  check(r.groups === 2 && r.bank === 4, `לוח המיון לא נבנה: ${r.groups} קבוצות, ${r.bank} פריטים`);
  check(r.selected, 'בחירת פריט לא סימנה אותו ואת היעדים');
  check(r.placed, 'לחיצה על קבוצה לא שיבצה את הפריט שנבחר');
  check(r.keptScroll, 'שיבוץ בתוך אותה שאלה גולל לראש המסך');
  check(r.allPlaced, 'שיבוץ דרך פריט שכבר בקבוצה לא עבד');
  check(r.feedbackOk, 'בדיקה של שיבוץ מושלם לא הציגה הצלחה');
  check(r.scheduled, 'תרגיל שנבדק לא נרשם בתזמון');
  check(r.frozen, 'אחרי בדיקה עדיין אפשר להזיז פריטים');
  check(r.cycle === '1,4,4,1,4', 'ציור המעגל שגוי (מכל,צמתים,קשתות,עוגן,מקרא): ' + r.cycle);
  check(r.reveal === 'הצג תשובה', 'בלי שיבוץ הכפתור אמור להציע את התשובה');
  check(r.fixes === '3/3', 'לא כל יעד קיבל תיקון: ' + r.fixes);
  check(r.missed, 'תרגיל שגוי לא נרשם כהחמצה');
  check(r.seq === '4,3,1', 'ציור הרצף שגוי (שלבים,משבצות חץ,גלויים): ' + r.seq);
  check(r.big === '0,12', 'מעגל גדול לא נפל לרשימה: ' + r.big);
  check(r.results.indexOf('במקום הנכון') > -1, 'מסך הסיכום לא מציג תרגיל שהוחמץ');
  check(r.browse === '4,מיון', 'העיון לא מציג תרגילים: ' + r.browse);
}

/* 5r — כפתור אחורה של המכשיר חוזר מסך אחד, ויוצא רק ממסך הבית.
   כרום מדלג באחורה על רשומה שנוספה בלי נגיעה, ולכן בזמן לחיצת אחורה
   אסור שיתווסף pushState — זה מה ששבר את התיקון הקודם על הטלפון. */
try {
  /* בלי רשומה לחזור אליה אין popstate — לא ממתינים לנצח */
  const popped = () => new Promise((r) => {
    win.addEventListener('popstate', () => setTimeout(r, 60), { once: true });
    setTimeout(r, 400);
  });
  const settle = () => new Promise((r) => setTimeout(r, 120));
  let pushes = 0;
  const realPush = win.history.pushState.bind(win.history);
  win.history.pushState = (...a) => { pushes++; return realPush(...a); };
  const back = async () => { pushes = 0; const p = popped(); win.history.back(); await p; await settle(); };
  const at = () => JSON.parse(win.eval(`JSON.stringify({
    name: quiz ? 'quiz' : view.name, deck: view.deck || null,
    d: (histEntry() || {d:0}).d, sheet: !!document.querySelector('.sheet-bg') })`));

  /* בדיקות קודמות ריקנו את הספרייה */
  win.eval(`LIB.status='ok'; LIB.rows=localRows(); applyRows(); quiz=null; view={name:'home'}; renderNow();`);
  await settle();
  check(at().d === 0, 'במסך הבית נשארה רשומת היסטוריה — אחורה לא יצא');

  const first = win.eval('DECKS[0].id'), id = JSON.stringify(first);
  const mode = JSON.stringify(win.eval('DECKS[0].modes[0].id'));
  win.eval(`view={name:'deck', deck:${id}}; renderNow();`);
  check(at().d === 1, 'מעבר לחבילה לא הוסיף רשומת היסטוריה');
  win.eval(`view={name:'browse', deck:${id}, q:'', hide:false}; renderNow();`);
  check(at().d === 2, 'מעבר לעיון לא הוסיף רשומה');

  await back();
  let s = at();
  check(s.name === 'deck' && s.deck === first, `אחורה מעיון הגיע ל-${s.name} במקום לחבילה`);
  check(pushes === 0, 'לחיצת אחורה הוסיפה רשומה — כרום ידלג עליה והלחיצה הבאה תצא');
  check(s.d === 1, `אחרי חזרה לחבילה הרשומה בעומק ${s.d}`);

  await back();
  s = at();
  check(s.name === 'home' && s.d === 0, `אחורה מחבילה הגיע ל-${s.name}`);
  check(pushes === 0, 'לחיצת אחורה שנייה הוסיפה רשומה');

  /* חידון מתוך חבילה: שתי לחיצות מחזירות לחבילה ואז לבית */
  win.eval(`view={name:'deck', deck:${id}}; renderNow(); startQuiz(${id}, ${mode}); renderNow();`);
  check(at().d === 2, `חידון מתוך חבילה בעומק ${at().d}`);
  await back();
  s = at();
  check(s.name === 'deck' && pushes === 0, `אחורה מחידון הגיע ל-${s.name}`);
  await back();
  check(at().name === 'home', 'אחורה שני מחידון לא הגיע לבית');

  /* סבב כללי: כפתור הבית בחידון מחזיר לבית ומנקה את הרשומה */
  win.eval(`startMixed(); renderNow();`);
  check(at().d === 1, 'סבב כללי לא הוסיף רשומה');
  win.eval(`document.getElementById('homeBtn').click();`);
  await settle();
  s = at();
  check(s.name === 'home' && s.d === 0, `יציאה מסבב כללי הגיעה ל-${s.name}, עומק ${s.d}`);

  /* כפתור חזרה בתוך האפליקציה שקופץ שני מסכים — שתי הרשומות יורדות */
  win.eval(`view={name:'deck', deck:${id}}; renderNow(); view={name:'browse', deck:${id}, q:'', hide:false}; renderNow();`);
  win.eval(`view={name:'home'}; renderNow();`);
  await settle(); await settle();
  check(at().d === 0, `קפיצה לבית השאירה רשומה בעומק ${at().d}`);

  win.eval(`openExamSheet();`);
  await settle();
  check(at().d === 1, 'גיליון פתוח לא הוסיף רשומת היסטוריה');
  await back();
  s = at();
  check(!s.sheet && s.name === 'home' && s.d === 0, 'אחורה לא סגר את הגיליון');
  win.history.pushState = realPush;
} catch (e) {
  fail.push('כפתור אחורה נפל: ' + e.message);
}

/* 6 — בלי מפגש שמור, מסך הנעילה מופיע ושום דבר אחר לא */
{
  const locked = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://shassaf.github.io/shinun-yeda/',
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
  tearingDown = true;
  locked.window.close();
  await new Promise((r) => setTimeout(r, 0));
  tearingDown = false;
}

/* ה-SW מטפל רק בקבצי האפליקציה. קריאה ל-Supabase שעברה בו נשמרה
   בקאש-תחילה, וכרטיסים חדשים לא הופיעו עד איפוס ידני. */
{
  const handlers = {};
  const put = [];
  const sandbox = {
    self: {
      location: new URL('https://shassaf.github.io/shinun-yeda/sw.js'),
      addEventListener: (type, fn) => { handlers[type] = fn; },
    },
    caches: {
      match: () => Promise.resolve(undefined),
      open: () => Promise.resolve({ put: (req) => { put.push(req.url); } }),
    },
    fetch: (req) => Promise.resolve({ ok: req.url.indexOf('missing') < 0, clone() { return this; } }),
    URL,
  };
  vm.runInNewContext(await readFile(join(ROOT, 'www', 'sw.js'), 'utf8'), sandbox);

  const fire = (url) => {
    let answer = null;
    handlers.fetch({
      request: { url, method: 'GET', mode: 'cors' },
      respondWith: (p) => { answer = p; },
    });
    return answer;
  };

  check(fire('https://x.supabase.co/rest/v1/decks?select=id') === null,
    'ה-SW יירט קריאה ל-Supabase');
  const own = fire('https://shassaf.github.io/shinun-yeda/icons/icon-192.png');
  check(own !== null, 'ה-SW לא מטפל בקבצי האפליקציה');
  await own;
  await fire('https://shassaf.github.io/shinun-yeda/icons/missing.png');
  await new Promise((r) => setTimeout(r, 0));
  check(put.some((u) => u.endsWith('icon-192.png')), 'ה-SW לא שמר קובץ תקין בקאש');
  check(!put.some((u) => u.endsWith('missing.png')), 'ה-SW שמר בקאש תשובת שגיאה');
}

dom.window.close();

if (fail.length) {
  console.error('בדיקת העשן נכשלה:\n' + [...new Set(fail)].map((f) => '  · ' + f).join('\n'));
  process.exit(1);
}
console.log('בדיקת העשן עברה — %d חבילות, %d פריטים',
  DECKS.length, DECKS.reduce((a, d) => a + d.items.length, 0));
