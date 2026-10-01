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
/* קריסה של הבדיקה עצמה (eval שזרק, הבטחה שנדחתה) לא תבלע את מה שכבר
   נמצא — הרשימה מודפסת גם אם התהליך נופל באמצע */
let reported = false;
process.on('unhandledRejection', (e) => { fail.push('דחייה לא מטופלת: ' + ((e && e.message) || e)); });
process.on('exit', () => {
  if (!reported && fail.length)
    console.error('בדיקת העשן נכשלה לפני הסוף:\n' + [...new Set(fail)].map((f) => '  · ' + f).join('\n'));
});

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

/* עזרים לבדיקות הסנכרון, בתוך הדף:
   __session(uid) — מפגש עם JWT תקף שמכיל sub, כך שאין רענון שנופל לתוך ה-mock
   __mock(handler) — מחליף את fetch, מתעד כל בקשה (כותרות באותיות קטנות, גוף מפוענח)
                     ועונה לפי handler({url, method, headers, body}) → {status, body|text} */
win.eval(`
  window.__session = function(uid){
    const good = Math.floor(Date.now()/1000) + 3600;
    return {access:'h.' + btoa(JSON.stringify({exp:good, sub:uid, email:uid + '@t'})) + '.s',
            refresh:'r-' + uid, uid:uid, email:uid + '@t'};
  };
  window.__mock = function(handler){
    const sent = [], real = fetch;
    fetch = function(url, init){
      const h = (init && init.headers) || {}, hdr = {};
      Object.keys(h).forEach(function(k){ hdr[k.toLowerCase()] = h[k]; });
      const req = {url:String(url), method:(init && init.method) || 'GET', headers:hdr,
                   body:init && init.body ? JSON.parse(init.body) : null};
      sent.push(req);
      const res = handler(req) || {status:200, body:[]};
      const text = res.text != null ? res.text : JSON.stringify(res.body === undefined ? [] : res.body);
      return Promise.resolve({ok:res.status >= 200 && res.status < 300, status:res.status,
        json:function(){ return Promise.resolve(text ? JSON.parse(text) : null); },
        text:function(){ return Promise.resolve(text); }});
    };
    return {sent:sent, restore:function(){ fetch = real; }};
  };
  window.__quiet = function(){
    if(cardSyncTimer){ clearTimeout(cardSyncTimer); cardSyncTimer = null; }
    cardSync = null; cardSyncAgain = false; cardSyncFull = false;
  };
`);

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

    /* מצב הפתיחה: מטמון, ועוד לא פנינו לשרת — אין על מה להזהיר */
    LIB.status='cached'; LIB.reason=null; LIB.rows=snap; applyRows(); renderNow();
    out.boot = {decks:DECKS.length, warns:app.innerHTML.indexOf('מוצג מהמטמון המקומי') > -1};

    LIB.status='cached'; LIB.reason='HTTP 503'; applyRows(); renderNow();
    out.cached = {decks:DECKS.length, warns:app.innerHTML.indexOf('מוצג מהמטמון המקומי') > -1,
                  reason:app.innerHTML.indexOf('HTTP 503') > -1,
                  button:!!document.getElementById('refreshLib')};

    LIB.status='ok'; LIB.reason=null; applyRows(); renderNow();
    return JSON.stringify(out);
  })()`));
  check(states.unknown.decks === 0 && states.unknown.html, 'מצב unknown לא מציג טעינה');
  check(states.error.decks === 0 && states.error.shows, 'מצב error לא מציג שגיאה');
  check(states.error.reason, 'מצב error לא מציג את הסיבה');
  check(states.empty.decks === 0 && states.empty.shows, 'ספרייה ריקה מהשרת לא מציגה מצב ריק');
  check(states.cached.decks > 0, 'מטמון לא מוצג');
  check(states.cached.warns, 'הצגת מטמון ישן לא מסומנת למשתמש');
  check(states.cached.reason, 'אזהרת המטמון לא מציגה את הסיבה');
  check(!states.cached.button, 'כפתור רענון המטמון עדיין מוצג — הסנכרון אמור לחזור לבד');
  check(states.boot.decks > 0 && !states.boot.warns, 'אזהרת המטמון מופיעה בפתיחה לפני שנוסה השרת');
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

  /* דיווח שנכשל לא מייצר תקלה נוספת (אחרת נוצרת לולאה), אבל תקלה אחרת
     שקורית בזמן השליחה נרשמת — פעם היא נבלעה */
  const noLoop = JSON.parse(await win.eval(`(function(){
    const save = {AUTH:AUTH, UID:UID}, realFetch = fetch;
    ERRQ = [{kind:'client', message:'ממתין בתור', context:null, at:new Date().toISOString(), uid:null}];
    logging = false; loggingAgain = false;
    AUTH = __session('u-err'); UID = 'u-err';
    const sent = [];
    fetch = function(url, init){
      sent.push(JSON.parse(init.body));
      return Promise.resolve({ok:false, status:500, json:function(){ return Promise.resolve({}); },
                              text:function(){ return Promise.resolve(''); }});
    };
    const p = flushErrors();
    logError('fetch', 'תקלה אחרת בזמן השליחה', null);
    return p.then(function(){ return new Promise(function(r){ setTimeout(r, 60); }); }).then(function(){
      fetch = realFetch; AUTH = save.AUTH; UID = save.UID;
      const out = {n: ERRQ.length, stamped: sent.length ? sent[0].every(function(x){ return x.user_id === 'u-err' && x.at && !('uid' in x); }) : false};
      ERRQ = []; logging = false; loggingAgain = false;
      jwrite(ERRQ_KEY, ERRQ);
      return JSON.stringify(out);
    });
  })()`));
  check(noLoop.n === 2, `שליחה שנכשלה או תקלה במקביל: ${noLoop.n} רשומות במקום 2`);
  check(noLoop.stamped, 'שורת יומן נשלחה בלי user_id, בלי זמן התקלה, או עם שדה מקומי');

  /* בקשה שנקטעה כי הדף יוצא (טעינה מחדש אחרי דיפלוי) אינה תקלה.
     שתי התקלות היחידות ביומן היו בדיוק זה. דף שחזר — נרשם שוב. */
  const leave = JSON.parse(await win.eval(`(function(){
    const save = {AUTH:AUTH, UID:UID}, realFetch = fetch;
    AUTH = __session('u-leave'); UID = 'u-leave';
    ERRQ = []; logging = true;          /* בלי שליחה — רק מה שנרשם */
    fetch = function(){ return Promise.reject(new TypeError('Failed to fetch')); };
    const probe = function(){ return rest('decks?select=id').catch(function(){}); };
    dispatchEvent(new Event('pagehide'));
    return probe().then(function(){
      const away = ERRQ.length;
      dispatchEvent(new Event('pageshow'));
      return probe().then(function(){
        const back = ERRQ.length;
        fetch = realFetch; AUTH = save.AUTH; UID = save.UID;
        ERRQ = []; logging = false; loggingAgain = false; leaving = false;
        jwrite(ERRQ_KEY, ERRQ);
        return JSON.stringify({away:away, back:back});
      });
    });
  })()`));
  check(leave.away === 0, 'בקשה שנקטעה ביציאה מהדף נרשמה ביומן');
  check(leave.back === 1, 'אחרי חזרה לדף, בקשה שנכשלה לא נרשמה ביומן');

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
  check(src.indexOf('bindUser(') > -1 && src.indexOf('bindUser(') < src.indexOf('renderNow()'),
    'הציור הראשון קורה לפני שנקבע של מי הנתונים');
  check(src.indexOf('loadIdentity()') > -1 && src.indexOf('loadIdentity()') < src.indexOf('syncAll()'),
    'הסנכרון רץ לפני שהזהות נפתרה');
  check(src.indexOf('booted') > -1, 'העלייה יכולה לרוץ פעמיים');
  const all = win.eval('syncAll.toString()');
  ['syncLibrary()', 'syncCards(true)', 'syncSettings()', 'flushErrors()', 'checkAdmin()'].forEach(function(x){
    check(all.indexOf(x) > -1, 'הסנכרון המלא לא כולל ' + x);
  });

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
  check(src.indexOf('if(q.whyBusy || whyFor(whyKeyOf(q))) return;') > -1,
    'כישלון קודם חוסם ניסיון חוזר של «למה»');
  /* הסבר נכתב על טעות מסוימת: תשובה אחרת או תיקון בכרטיס = מפתח אחר */
  const wk = JSON.parse(win.eval(`(function(){
    const mk = function(ans, main){ return {key:'d:a', label:'L', prompt:{kind:'text', main:'x'},
      options:[{id:'a',main:main||'A'},{id:'b',main:'B'},{id:'c',main:'C'}], answer:'a', answered:ans}; };
    const k1 = whyKeyOf(mk('b'));
    return JSON.stringify({chosen: k1 !== whyKeyOf(mk('c')), edit: k1 !== whyKeyOf(mk('b', 'A2')),
                           stable: k1 === whyKeyOf(mk('b'))});
  })()`));
  check(wk.chosen, 'הסבר לתשובה אחת מוצג גם כשנבחרה תשובה אחרת');
  check(wk.edit, 'הסבר ישן מוצג אחרי תיקון הכרטיס');
  check(wk.stable, 'מפתח ההסבר לא יציב');
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

/* 5k — אין כפתור איפוס או רענון של המטמון המקומי: הסנכרון מתעדכן לבד
   (חזרה לאפליקציה, חזרת רשת, ניסיון חוזר במרווחים) */
{
  check(win.eval('typeof hardReset') === 'undefined', 'פונקציית איפוס המטמון עדיין קיימת');
  const storeSrc = win.eval('renderStore.toString()');
  check(storeSrc.indexOf('wipeCache') < 0, 'כפתור "אפס מטמון מקומי" עדיין במאגר');
  check(win.eval('renderHome.toString()').indexOf('refreshLib') < 0, 'כפתור "רענן" עדיין בבית');
  const tail = win.eval('syncAll.toString() + scheduleRetry.toString() + resync.toString()');
  check(tail.indexOf('scheduleRetry(') > -1, 'סנכרון שנכשל לא מנסה שוב לבד');
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
  check(win.eval('syncSettings.toString()').indexOf('pullSettings()') > -1 &&
        win.eval('syncAll.toString()').indexOf('syncSettings()') > -1,
    'ההגדרות לא נמשכות בעלייה');
  check(win.eval('next.toString()').indexOf('pushSettings()') > -1,
    'סיום סבב לא נשמר בשרת');
  check(win.eval('openExamSheet.toString()').indexOf('pushSettings()') > -1,
    'תאריך המבחן לא נשמר בשרת');
  check(win.eval('typeof store.best') === 'undefined', 'שדה השיא המת עדיין קיים');

  /* כתיבות מהירות מתאחדות */
  const merged = JSON.parse(await win.eval(`(function(){
    const realRest = rest, save = {AUTH:AUTH, UID:UID};
    let calls = 0;
    AUTH = __session('u'); UID = 'u';
    pushingSettings = null; settingsAgain = false;
    rest = function(){ calls++; return Promise.resolve({ok:true}); };
    const a = pushSettings(), b = pushSettings(), c = pushSettings();
    const shared = (a === b) && (b === c);
    return Promise.all([a,b,c]).then(function(){
      rest = realRest; AUTH = save.AUTH; UID = save.UID;
      return JSON.stringify({calls:calls, shared:shared});
    });
  })()`));
  check(merged.shared, 'כתיבות הגדרות מקבילות לא התאחדו');
  check(merged.calls === 1, 'נשלחו ' + merged.calls + ' בקשות הגדרות במקום אחת');

  /* שינוי שנעשה בזמן שליחה נשלח מיד אחריה — פעם הוא נבלע, והמשיכה
     הבאה החזירה את התאריך שנמחק */
  const trail = JSON.parse(await win.eval(`(function(){
    const realRest = rest, save = {AUTH:AUTH, UID:UID, store:store};
    AUTH = __session('uT'); UID = 'uT'; store = defaultSettings();
    const bodies = []; let release;
    rest = function(path, init){
      bodies.push({body:JSON.parse(init.body), prefer:(init.headers || {}).Prefer});
      if(bodies.length === 1) return new Promise(function(r){ release = function(){ r({ok:true}); }; });
      return Promise.resolve({ok:true});
    };
    pushingSettings = null; settingsAgain = false;
    setExamDate('2027-01-01'); const a = pushSettings();
    setExamDate(null); pushSettings();
    release();
    return a.then(function(){
      rest = realRest;
      const last = bodies[bodies.length - 1];
      const out = {calls:bodies.length, last:last.body.exam_date, at:last.body.updated_at,
                   examAt:new Date(store.examAt).toISOString(), dirty:store.dirty, prefer:last.prefer};
      localStorage.removeItem('bio-quiz-v2:uT');
      AUTH = save.AUTH; UID = save.UID; store = save.store; pushingSettings = null;
      return JSON.stringify(out);
    });
  })()`));
  check(trail.calls === 2, 'שינוי בזמן שליחה לא נשלח: ' + trail.calls + ' בקשות');
  check(trail.last === null, 'נשלח התאריך הישן במקום המחיקה');
  check(trail.at === trail.examAt, 'updated_at אינו זמן השינוי — השרת לא יוכל להכריע מי חדש יותר');
  check(trail.dirty === false, 'שינוי שנשמר בשרת נשאר מסומן כלא נשלח');
  check(String(trail.prefer).indexOf('merge-duplicates') > -1, 'שמירת ההגדרות בלי upsert');

  /* משיכה: תאריך חדש יותר מהשרת מנצח; שינוי מקומי שלא נשלח לא נדרס */
  const pull = JSON.parse(await win.eval(`(function(){
    const save = {AUTH:AUTH, UID:UID, store:store};
    AUTH = __session('uQ'); UID = 'uQ';
    const out = {};
    const serverRow = function(at){ return [{exam_date:'2027-02-02', rounds:5, updated_at:new Date(at).toISOString()}]; };
    store = {rounds:3, examDate:'2027-01-01', examAt:Date.now() - 60000, dirty:false};
    let m = __mock(function(){ return {status:200, body:serverRow(Date.now())}; });
    return pullSettings().then(function(){
      m.restore();
      out.newer = store.examDate + '|' + store.rounds;
      store = {rounds:9, examDate:'2027-03-03', examAt:Date.now(), dirty:true};
      m = __mock(function(){ return {status:200, body:serverRow(Date.now() - 3600000)}; });
      return pullSettings();
    }).then(function(){
      m.restore();
      out.kept = store.examDate + '|' + store.rounds;
      localStorage.removeItem('bio-quiz-v2:uQ');
      AUTH = save.AUTH; UID = save.UID; store = save.store;
      return JSON.stringify(out);
    });
  })()`));
  check(pull.newer === '2027-02-02|5', 'תאריך חדש מהשרת לא התקבל: ' + pull.newer);
  check(pull.kept === '2027-03-03|9', 'שינוי מקומי שלא נשלח נדרס מהשרת: ' + pull.kept);
}

/* 5s — rest() שומר את כותרות הקורא (Prefer), וההרשאה הטרייה גוברת.
   פעם הכותרות הוחלפו כולן, וכל upsert הפך להוספה שנדחתה ב-409. */
{
  const hdr = JSON.parse(await win.eval(`(function(){
    const save = AUTH; AUTH = __session('uH');
    const m = __mock(function(){ return {status:200, body:[]}; });
    return rest('x', {method:'POST', headers:{Prefer:'resolution=merge-duplicates', Authorization:'Bearer stale'}, body:'[]'})
      .then(function(){
        m.restore(); AUTH = save;
        const h = m.sent[0].headers;
        return JSON.stringify({prefer:h.prefer, auth:h.authorization});
      });
  })()`));
  check(hdr.prefer === 'resolution=merge-duplicates', 'rest() זרק את כותרת Prefer של הקורא');
  check(hdr.auth !== 'Bearer stale' && String(hdr.auth).indexOf('Bearer h.') === 0, 'rest() שלח הרשאה ישנה');
}

/* 5t — סנכרון הכרטיסים: משיכה, איחוד לפי החזרה המאוחרת, ושליחה עם
   user_id, מפתח אחד לכל כרטיס, ויומן עם מזהה וזמן החזרה */
{
  const r = JSON.parse(await win.eval(`(function(){
    __quiet();
    const save = {AUTH:AUTH, UID:UID, CARDS:CARDS, DIRTY:DIRTY, LOGQ:LOGQ};
    AUTH = __session('uS'); UID = 'uS';
    const T = Date.now(), D = 86400000;
    CARDS = {
      'd1:a': {s:2, d:5, due:T+D, last:T-1000,  reps:2, lapses:0},    /* מקומי חדש מהשרת */
      'd1:b': {s:1, d:5, due:T+D, last:T-5*D,   reps:1, lapses:0},    /* השרת חדש יותר */
      'd1:c': {s:1, d:5, due:T+D, last:T-D,     reps:1, lapses:0}     /* אין בשרת בכלל */
    };
    DIRTY = {'d1:a':1};
    LOGQ = [
      {id:'11111111-1111-4111-8111-111111111111', card_key:'d1:a', rating:3, elapsed_days:null, duration_ms:900, reviewed_at:new Date(T-2000).toISOString()},
      {id:'22222222-2222-4222-8222-222222222222', card_key:'d1:a', rating:4, elapsed_days:0, duration_ms:700, reviewed_at:new Date(T-1000).toISOString()}
    ];
    const server = [
      {card_key:'d1:a', stability:1, difficulty:5, due:new Date(T).toISOString(), last_review:new Date(T-3*D).toISOString(), reps:1, lapses:0},
      {card_key:'d1:b', stability:9, difficulty:4, due:new Date(T+9*D).toISOString(), last_review:new Date(T-D/2).toISOString(), reps:4, lapses:0}
    ];
    const m = __mock(function(req){
      if(req.method === 'GET' && req.url.indexOf('/rest/v1/card_state') > -1)
        return {status:200, body:req.url.indexOf('offset=0') > -1 ? server : []};
      return {status:201, text:''};
    });
    return syncCards(true).then(function(ok){
      m.restore();
      const post = function(t){ return m.sent.filter(function(x){ return x.method === 'POST' && x.url.indexOf('/rest/v1/' + t) > -1; }); };
      const cs = post('card_state'), lg = post('review_log');
      const out = {
        ok: ok,
        pullOwn: m.sent.some(function(x){ return x.method === 'GET' && x.url.indexOf('user_id=eq.uS') > -1; }),
        csUrl: cs[0] ? cs[0].url : '', csPrefer: cs[0] ? cs[0].headers.prefer : '',
        csKeys: cs[0] ? cs[0].body.map(function(x){ return x.card_key; }).sort().join(',') : '',
        csUser: cs[0] ? cs[0].body.every(function(x){ return x.user_id === 'uS'; }) : false,
        csKeysets: cs[0] ? new Set(cs[0].body.map(function(x){ return Object.keys(x).sort().join(); })).size : 0,
        csNewest: cs[0] ? (cs[0].body.filter(function(x){ return x.card_key === 'd1:a'; })[0] || {}).reps : 0,
        bAdopted: CARDS['d1:b'].reps === 4 && CARDS['d1:b'].s === 9,
        lgUrl: lg[0] ? lg[0].url : '', lgPrefer: lg[0] ? lg[0].headers.prefer : '',
        lgRows: lg[0] ? lg[0].body.length : 0,
        lgFields: lg[0] ? lg[0].body.every(function(x){ return x.user_id === 'uS' && x.client_id && x.reviewed_at && !('id' in x); }) : false,
        lgKeysets: lg[0] ? new Set(lg[0].body.map(function(x){ return Object.keys(x).sort().join(); })).size : 0,
        dirtyLeft: Object.keys(DIRTY).length, logLeft: LOGQ.length
      };
      ['shinun-cards:uS','shinun-dirty:uS','shinun-log:uS'].forEach(function(k){ localStorage.removeItem(k); });
      AUTH = save.AUTH; UID = save.UID; CARDS = save.CARDS; DIRTY = save.DIRTY; LOGQ = save.LOGQ;
      return JSON.stringify(out);
    });
  })()`));
  check(r.ok, 'סנכרון הכרטיסים לא הושלם');
  check(r.pullOwn, 'משיכת הכרטיסים לא מסוננת למשתמש');
  check(r.csUrl.indexOf('on_conflict=user_id,card_key') > -1, 'upsert של card_state בלי on_conflict');
  check(String(r.csPrefer).indexOf('resolution=merge-duplicates') > -1, 'upsert של card_state בלי Prefer');
  check(r.csKeys === 'd1:a,d1:c', 'נשלחו הכרטיסים הלא נכונים: ' + r.csKeys);
  check(r.csUser, 'שורת card_state נשלחה בלי user_id');
  check(r.csKeysets === 1, 'לשורות card_state ערכות מפתחות שונות');
  check(r.csNewest === 2, 'נשלח מצב ישן של הכרטיס');
  check(r.bAdopted, 'מצב חדש יותר מהשרת לא התקבל');
  check(r.lgUrl.indexOf('on_conflict=user_id,client_id') > -1, 'יומן החזרות בלי on_conflict — שליחה חוזרת תכפיל');
  check(String(r.lgPrefer).indexOf('ignore-duplicates') > -1, 'יומן החזרות בלי ignore-duplicates');
  check(r.lgRows === 2 && r.lgFields, 'יומן החזרות לא נשלח במלואו (user_id, client_id, reviewed_at)');
  check(r.lgKeysets === 1, 'לשורות היומן ערכות מפתחות שונות');
  check(r.dirtyLeft === 0 && r.logLeft === 0, `התור לא התרוקן אחרי הצלחה: ${r.dirtyLeft}/${r.logLeft}`);

  /* כישלונות: 500 משאיר הכול; עמודה שעוד לא קיימת (לפני המיגרציה)
     משאירה את היומן; נתון פסול (23514) נזרק כדי לא לחסום לנצח */
  const f = JSON.parse(await win.eval(`(function(){
    __quiet();
    const save = {AUTH:AUTH, UID:UID, CARDS:CARDS, DIRTY:DIRTY, LOGQ:LOGQ};
    AUTH = __session('uF'); UID = 'uF';
    const T = Date.now();
    const reset = function(){
      CARDS = {'d2:x': {s:1, d:5, due:T+1e7, last:T, reps:1, lapses:0}};
      DIRTY = {'d2:x':1};
      LOGQ = [{id:'33333333-3333-4333-8333-333333333333', card_key:'d2:x', rating:2, elapsed_days:null, duration_ms:10, reviewed_at:new Date(T).toISOString()}];
    };
    const out = {};
    const run = function(csStatus, lgStatus, lgText){
      reset(); __quiet();
      const m = __mock(function(req){
        if(req.url.indexOf('/rest/v1/card_state') > -1) return {status:csStatus, text:''};
        if(req.url.indexOf('/rest/v1/review_log') > -1) return {status:lgStatus, text:lgText || ''};
        return {status:201, text:''};
      });
      return syncCards(false).then(function(){ m.restore(); return Object.keys(DIRTY).length + '/' + LOGQ.length; });
    };
    return run(500, 201).then(function(x){ out.down = x;
      return run(201, 400, '{"code":"PGRST204","message":"Could not find the client_id column"}'); })
    .then(function(x){ out.premig = x; return run(201, 400, '{"code":"23514","message":"check"}'); })
    .then(function(x){ out.poison = x;
      ['shinun-cards:uF','shinun-dirty:uF','shinun-log:uF'].forEach(function(k){ localStorage.removeItem(k); });
      AUTH = save.AUTH; UID = save.UID; CARDS = save.CARDS; DIRTY = save.DIRTY; LOGQ = save.LOGQ;
      ERRQ = []; jwrite(ERRQ_KEY, ERRQ);
      return JSON.stringify(out);
    });
  })()`));
  check(f.down === '1/1', 'שרת שנפל מחק מהתור: ' + f.down);
  check(f.premig === '0/1', 'לפני המיגרציה היומן אמור להמתין: ' + f.premig);
  check(f.poison === '0/0', 'אצווה פסולה חוסמת את היומן לנצח: ' + f.poison);
}

/* 5u — הפרדה בין משתמשים באותו מכשיר, והעברה מהגרסה שלא הפרידה */
{
  const r = JSON.parse(win.eval(`(function(){
    __quiet();
    const save = {AUTH:AUTH, UID:UID};
    const T = Date.now();
    const legacy = {s:3, d:5, due:T+86400000, last:T-1000, reps:1, lapses:0};
    localStorage.setItem('shinun-cards', JSON.stringify({'fg:methyl': legacy}));
    localStorage.setItem('shinun-queue', JSON.stringify([{card_key:'fg:methyl', stability:3, difficulty:5,
      due:new Date(legacy.due).toISOString(), last_review:new Date(legacy.last).toISOString(), reps:1, lapses:0,
      _log:{card_key:'fg:methyl', rating:3, elapsed_days:null, duration_ms:900}}]));
    localStorage.setItem('bio-quiz-v2', JSON.stringify({rounds:7, examDate:'2027-01-01'}));
    localStorage.setItem('shinun-rows', JSON.stringify([
      {id:'pa', owner_id:'uA', visibility:'private', kind:'topic', title:'פרטי של A', data:[]},
      {id:'px', owner_id:'uX', visibility:'private', kind:'topic', title:'פרטי של X', data:[]}]));
    UID = null;
    AUTH = __session('uA'); bindUser('uA');
    const out = {};
    out.adopted = !!CARDS['fg:methyl'] && DIRTY['fg:methyl'] === 1;
    out.log = LOGQ.length === 1 && !!LOGQ[0].id && LOGQ[0].reviewed_at === new Date(legacy.last).toISOString();
    out.settings = store.rounds === 7 && store.examDate === '2027-01-01' && store.dirty === true;
    out.rows = LIB.rows.map(function(x){ return x.id; }).join(',');
    out.legacyGone = ['shinun-cards','shinun-queue','bio-quiz-v2','shinun-rows']
      .every(function(k){ return localStorage.getItem(k) === null; });

    AUTH = __session('uB'); bindUser('uB');
    out.bClean = Object.keys(CARDS).length === 0 && LOGQ.length === 0 && store.rounds === 0 &&
                 !store.examDate && LIB.rows.length === 0 && LIB.status === 'unknown';

    AUTH = __session('uA'); bindUser('uA');
    hardSignOut('בדיקה');
    out.memCleared = Object.keys(CARDS).length === 0 && UID === null && !AUTH;
    out.diskKept = !!JSON.parse(localStorage.getItem('shinun-cards:uA') || '{}')['fg:methyl'] &&
                   JSON.parse(localStorage.getItem('shinun-log:uA') || '[]').length === 1;
    AUTH = __session('uA'); bindUser('uA');
    out.back = !!CARDS['fg:methyl'] && LOGQ.length === 1 && store.rounds === 7;

    storageKeys().filter(function(k){ return /:u[AB]$/.test(k); }).forEach(jremove);
    AUTH = save.AUTH; authWrite(AUTH); bindUser(save.UID);
    LIB.status = 'ok'; LIB.rows = localRows(); applyRows();
    quiz = null; view = {name:'home'}; renderNow();
    return JSON.stringify(out);
  })()`));
  check(r.adopted, 'כרטיס מהגרסה הקודמת לא עבר למשתמש הראשון, או לא סומן לשליחה');
  check(r.log, 'התור הישן לא הומר ליומן עם מזהה וזמן החזרה');
  check(r.settings, 'ההגדרות מהגרסה הקודמת לא עברו');
  check(r.rows === 'pa', 'עברה חבילה פרטית של משתמש אחר: ' + r.rows);
  check(r.legacyGone, 'המפתחות הישנים לא נמחקו אחרי ההעברה');
  check(r.bClean, 'משתמש שני רואה נתונים של הראשון');
  check(r.memCleared, 'התנתקות לא ניקתה את הזיכרון');
  check(r.diskKept, 'התנתקות מחקה תרגול שעוד לא נשלח');
  check(r.back, 'כניסה חוזרת לא החזירה את הנתונים של המשתמש');
}

/* 5v — מפתחות מהתקופה של התוכן המוטמע עוברים לחבילה המיובאת */
{
  const r = JSON.parse(win.eval(`(function(){
    const save = {UID:UID, CARDS:CARDS, DIRTY:DIRTY, LOGQ:LOGQ, rows:LIB.rows};
    UID = 'uR';
    const r0 = localRows()[0], nid = '11111111-aaaa-4aaa-8aaa-111111111111';
    LIB.rows = [{id:nid, owner_id:'uR', kind:r0.kind, title:r0.title, data:r0.data, visibility:'private'}];
    const T = Date.now(), ok = r0.id + ':' + r0.data[0].id, nk = nid + ':' + r0.data[0].id;
    CARDS = {}; CARDS[ok] = {s:5, d:5, due:T+1e8, last:T-1000, reps:3, lapses:0};
    DIRTY = {}; DIRTY[ok] = 1;
    LOGQ = [{id:'x', card_key:ok, rating:3, reviewed_at:new Date(T).toISOString()}];
    remapLegacyKeys();
    const out = {has:!!CARDS[nk], dirty:DIRTY[nk] === 1, oldGone:!CARDS[ok] && !DIRTY[ok], log:LOGQ[0].card_key === nk};
    ['shinun-cards:uR','shinun-dirty:uR','shinun-log:uR'].forEach(function(k){ localStorage.removeItem(k); });
    UID = save.UID; CARDS = save.CARDS; DIRTY = save.DIRTY; LOGQ = save.LOGQ; LIB.rows = save.rows; refreshLegacyMap();
    return JSON.stringify(out);
  })()`));
  check(r.has && r.dirty, 'ההיסטוריה לא עברה למפתח של החבילה המיובאת');
  check(r.oldGone, 'המפתח הישן נשאר ויישלח כיתום');
  check(r.log, 'יומן החזרות לא עבר למפתח החדש');
}

/* 5w — המאגר נטען גם כשיש חבילות ציבוריות (פעם קרס: subs היה אובייקט) */
{
  const r = JSON.parse(await win.eval(`(function(){
    const save = {AUTH:AUTH, UID:UID, sl:syncLibrary, fs:fetchStore, fr:fetchReviewStatus, subs:LIB.subs, rows:LIB.rows};
    AUTH = __session('uP'); UID = 'uP';
    LIB.subs = ['p1'];
    LIB.rows = [{id:'m1', owner_id:'uP', kind:'topic', title:'שלי', visibility:'public', item_count:4, data:[]}];
    syncLibrary = function(){ return Promise.resolve({ok:true}); };
    fetchStore = function(){ return Promise.resolve({ok:true, data:[
      {id:'p1', title:'א', item_count:5, visibility:'public', owner_id:'o'},
      {id:'p2', title:'ב', item_count:6, visibility:'public', owner_id:'o'}]}); };
    fetchReviewStatus = function(){ return Promise.resolve({m1:{id:'m1', review_status:'pending'}}); };
    lastPaintError = null;
    openStore();
    return new Promise(function(res){ setTimeout(res, 40); }).then(function(){
      renderNow();
      const out = {
        subs: Array.from(document.querySelectorAll('[data-sub]')).map(function(b){ return b.dataset.sub + ':' + b.textContent.trim(); }).join(','),
        pending: (document.querySelector('.vis.wait') || {}).textContent || '',
        link: document.querySelectorAll('[data-link]').length,
        crash: lastPaintError
      };
      syncLibrary = save.sl; fetchStore = save.fs; fetchReviewStatus = save.fr;
      AUTH = save.AUTH; UID = save.UID; LIB.subs = save.subs; LIB.rows = save.rows;
      quiz = null; view = {name:'home'}; renderNow();
      return JSON.stringify(out);
    });
  })()`));
  check(!r.crash, 'המאגר קרס: ' + r.crash);
  check(r.subs === 'p1:הסר,p2:הוסף', 'המינויים במאגר שגויים: ' + r.subs);
  check(r.pending === 'ממתין לאישור', 'נושא שממתין לאישור לא מסומן אצל הבעלים');
  check(r.link === 0, 'קישור שיתוף מוצע לנושא שעוד לא אושר');
}

/* 5x — ניהול: מוצג רק לאדמין; תור אישור, ציבוריות ומערכת */
{
  const r = JSON.parse(win.eval(`(function(){
    const save = AUTH;
    quiz = null;
    AUTH = Object.assign({}, save, {admin:false}); view = {name:'home'}; renderNow();
    const out = {hidden: !document.getElementById('adminBtn')};
    AUTH = Object.assign({}, save, {admin:true}); ADMIN.pending = 2; renderNow();
    const btn = document.getElementById('adminBtn');
    out.shown = !!btn && btn.textContent.indexOf('2') > -1;
    view = {name:'admin', tab:'queue', loading:false, loaded:true, decks:[
      {id:'q1', title:'ממתין', review_status:'pending', visibility:'public', owner_email:'a@b', item_count:4},
      {id:'q2', title:'אושר', review_status:'approved', visibility:'public', owner_email:'c@d', item_count:9},
      {id:'q3', title:'נדחה', review_status:'rejected', visibility:'private', owner_email:'e@f', item_count:3, review_note:'לא מדויק'}]};
    renderNow();
    out.queue = [document.querySelectorAll('.arow').length, document.querySelectorAll('[data-approve]').length,
                 document.querySelectorAll('[data-reject]').length, document.querySelectorAll('[data-adel]').length,
                 document.querySelectorAll('[data-preview]').length].join();
    view.tab = 'public'; renderNow();
    out.pub = [document.querySelectorAll('.arow:not(.bulk)').length, document.querySelectorAll('[data-approve]').length,
               document.querySelectorAll('[data-reject]').length].join();
    view.tab = 'system'; renderNow();
    out.sys = !!document.getElementById('syncNow') && !document.getElementById('wipeCache');
    ADMIN.pending = 0; AUTH = save; view = {name:'home'}; renderNow();
    return JSON.stringify(out);
  })()`));
  check(r.hidden, 'כפתור הניהול מוצג למי שאינו אדמין');
  check(r.shown, 'כפתור הניהול לא מוצג לאדמין, או בלי מספר הממתינים');
  check(r.queue === '1,1,1,1,1', 'תור האישור שגוי (שורות,אשר,דחה,מחק,תצוגה): ' + r.queue);
  check(r.pub === '2,0,1', 'לשונית הציבוריות שגויה (שורות,אשר,הסתר): ' + r.pub);
  check(r.sys, 'לשונית המערכת חסרה את "סנכרן עכשיו" או עדיין מציעה איפוס מטמון');
  check(win.eval('parentOf(null, {name:"browse", preview:{}, fromTab:"queue"}).name') === 'admin',
    'אחורה מתצוגה מקדימה לא חוזר לניהול');
}

/* 5y — תוכן ציבורי לא יכול להזריק HTML, ושורה פגומה לא מפילה את הספרייה */
{
  const r = JSON.parse(win.eval(`(function(){
    const out = {};
    out.esc = esc('"' + "'" + '<>&');
    out.color = safeColor('red" onmouseover="x', 'var(--c-o)');
    out.good = [safeColor('var(--c-n)'), safeColor('#abc'), safeColor('teal')].join(',');
    const rows = [
      {id:'bad1', kind:'groups', title:'שבור', data:[null, {id:'a'}, 5]},
      {id:'bad2', kind:'topic', title:'צבע', color:'x" data-pwned="1', data:[
        {id:'a',front:'1',back:'a'},{id:'b',front:'2',back:'b'},{id:'c',front:'3',back:'c'},
        {id:'d" data-pwned="1',front:'4',back:'d'}]},
      {id:'bad3', kind:'elements', title:'ריק', data:'not-an-array'},
      {id:'bad4', kind:'iso', title:'בלי נתונים', data:null},
      'לא אובייקט'
    ];
    let threw = null, built = [];
    try{ built = buildDecks(rows); }catch(e){ threw = e.message; }
    out.threw = threw;
    out.built = built.map(function(d){ return d.id; }).join(',');
    const saveRows = LIB.rows;
    LIB.rows = rows; LIB.status = 'ok'; applyRows();
    quiz = null; view = {name:'home'}; lastPaintError = null; renderNow();
    out.home = !!document.querySelector('.deck-list');
    view = {name:'browse', deck:'bad2', q:'', hide:false}; renderNow();
    out.browse = document.querySelectorAll('.bcard').length;
    startQuiz('bad2', 'f2b'); renderNow();
    out.quiz = document.querySelectorAll('.opt').length;
    out.pwned = document.querySelectorAll('[data-pwned]').length;
    out.crash = lastPaintError;
    quiz = null; view = {name:'home'};
    LIB.rows = saveRows; applyRows(); renderNow();
    return JSON.stringify(out);
  })()`));
  check(r.esc === '&quot;&#39;&lt;&gt;&amp;', 'esc לא מגן על ערך של מאפיין: ' + r.esc);
  check(r.color === 'var(--c-o)', 'צבע עם גרשיים עבר: ' + r.color);
  check(r.good === 'var(--c-n),#abc,teal', 'צבע תקין נפסל: ' + r.good);
  check(r.threw === null, 'שורה פגומה הפילה את בניית הספרייה: ' + r.threw);
  check(r.built === 'bad2', 'בניית הספרייה מהשורות הפגומות: ' + r.built);
  check(r.home && !r.crash, 'מסך הבית לא עלה עם שורה פגומה: ' + r.crash);
  check(r.browse === 4 && r.quiz === 4, `חבילה עם מזהה חשוד לא הוצגה (${r.browse}/${r.quiz})`);
  check(r.pwned === 0, 'תוכן ציבורי הזריק מאפיין HTML');
}

/* 5z — תחזית העומס סופרת רק כרטיסים שבספרייה; מקלדת לא עונה ממסך הנעילה */
{
  const r = JSON.parse(win.eval(`(function(){
    const total = function(){ return forecast(14).reduce(function(a, x){ return a + x.n; }, 0); };
    const before = total();
    CARDS['deleted-deck:x'] = {s:1, d:5, due:Date.now() - 1000, last:Date.now() - 2000, reps:1, lapses:0};
    const after = total();
    delete CARDS['deleted-deck:x'];

    const save = AUTH, deck = DECKS.filter(function(d){ return !d.min; })[0] || DECKS[0];
    startQuiz(deck.id, deck.modes[0].id);
    const q = quiz.qs[0];
    AUTH = null; renderNow();
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'1'}));
    const out = {before:before, after:after, answered:!!q.answered, lock:!!document.querySelector('.lock')};
    AUTH = save; quiz = null; view = {name:'home'}; renderNow();
    return JSON.stringify(out);
  })()`));
  check(r.before === r.after, `כרטיס יתום נספר בתחזית (${r.before} → ${r.after})`);
  check(r.lock && !r.answered, 'מקש מספר ענה על שאלה מאחורי מסך הנעילה');
}

/* 5aa — מפתחות ישנים: לא נשלחים לפני שהספרייה אומתה, ושורה ישנה בשרת
   לא גורמת לשליחה חוזרת וציור מחדש בכל סנכרון */
{
  const r = JSON.parse(await win.eval(`(function(){
    __quiet();
    const save = {AUTH:AUTH, UID:UID, CARDS:CARDS, DIRTY:DIRTY, LOGQ:LOGQ, rows:LIB.rows, status:LIB.status};
    AUTH = __session('uL'); UID = 'uL';
    const r0 = localRows()[0], nid = '22222222-bbbb-4bbb-8bbb-222222222222';
    const item = r0.data[0].id, oldKey = r0.id + ':' + item, newKey = nid + ':' + item;
    const T = Date.now();
    CARDS = {}; CARDS[oldKey] = {s:4, d:5, due:T+1e8, last:T-5000, reps:2, lapses:0};
    DIRTY = {}; DIRTY[oldKey] = 1; LOGQ = [];
    LIB.status = 'cached'; LIB.rows = []; LEGACY_READY = false; refreshLegacyMap();
    const out = {};
    let m = __mock(function(){ return {status:201, text:''}; });
    return syncCards(false).then(function(){
      m.restore();
      out.heldBeforeLibrary = m.sent.filter(function(x){ return x.url.indexOf('card_state') > -1; }).length === 0;
      LIB.status = 'ok';
      LIB.rows = [{id:nid, owner_id:'uL', kind:r0.kind, title:r0.title, data:r0.data, visibility:'private'}];
      remapLegacyKeys();
      /* בשרת: גם שורה ישנה תחת המפתח הישן וגם המפתח החדש, באותו מצב —
         בסדר של order=card_key, כמו ש-PostgREST מחזיר (ספרות לפני אותיות) */
      const st = CARDS[newKey];
      const row = function(k){ return {card_key:k, stability:st.s, difficulty:st.d, due:new Date(st.due).toISOString(),
                                       last_review:new Date(st.last).toISOString(), reps:st.reps, lapses:st.lapses}; };
      const server = [row(oldKey), row(newKey)].sort(function(a, b){ return a.card_key < b.card_key ? -1 : 1; });
      DIRTY = {};
      let posts = 0;
      const once = function(){
        __quiet();
        m = __mock(function(req){
          if(req.method === 'GET') return {status:200, body:req.url.indexOf('offset=0') > -1 ? server : []};
          posts++; return {status:201, text:''};
        });
        return syncCards(true).then(function(){ m.restore(); });
      };
      return once().then(once).then(once).then(function(){
        out.noChurn = posts === 0 && Object.keys(DIRTY).length === 0;
        ['shinun-cards:uL','shinun-dirty:uL','shinun-log:uL'].forEach(function(k){ localStorage.removeItem(k); });
        AUTH = save.AUTH; UID = save.UID; CARDS = save.CARDS; DIRTY = save.DIRTY; LOGQ = save.LOGQ;
        LIB.rows = save.rows; LIB.status = save.status; refreshLegacyMap();
        return JSON.stringify(out);
      });
    });
  })()`));
  check(r.heldBeforeLibrary, 'מפתח ישן נשלח לפני שהספרייה אומתה — ייווצרו שתי שורות לאותו כרטיס');
  check(r.noChurn, 'שורה ישנה בשרת גורמת לשליחה חוזרת בכל סנכרון');
}

/* 5ab — מטמון ישן של משתמש אחר לא מאומץ; הגדרות בלי תאריך לא מוחקות תאריך */
{
  const r = JSON.parse(win.eval(`(function(){
    const save = {AUTH:AUTH, UID:UID};
    localStorage.setItem('shinun-cards', JSON.stringify({'fg:x': {s:1, d:5, due:Date.now(), last:Date.now(), reps:1, lapses:0}}));
    localStorage.setItem('shinun-rows', JSON.stringify([{id:'pa', owner_id:'uA', visibility:'private', kind:'topic', title:'של A', data:[]}]));
    UID = null; AUTH = __session('uB'); bindUser('uB');
    const out = {
      notAdopted: !CARDS['fg:x'] && localStorage.getItem('shinun-cards:uB') === null,
      legacyKept: localStorage.getItem('shinun-cards') !== null
    };
    ['shinun-cards','shinun-rows'].forEach(function(k){ localStorage.removeItem(k); });
    storageKeys().filter(function(k){ return /:uB$/.test(k); }).forEach(jremove);
    /* תאריך מהגרסה הקודמת: חדש מ"אין תאריך", ישן מכל שינוי אמיתי */
    localStorage.setItem('bio-quiz-v2', JSON.stringify({rounds:2, examDate:'2027-01-01'}));
    UID = null; AUTH = __session('uC'); bindUser('uC');
    out.legacyExamAt = store.examAt === 1 && store.dirty === true;
    storageKeys().filter(function(k){ return /:uC$/.test(k); }).forEach(jremove);
    AUTH = save.AUTH; bindUser(save.UID);
    LIB.status = 'ok'; LIB.rows = localRows(); applyRows(); quiz = null; view = {name:'home'}; renderNow();
    return JSON.stringify(out);
  })()`));
  check(r.notAdopted && r.legacyKept, 'היסטוריה של משתמש אחר אומצה לחשבון של מי שנכנס אחריו');
  check(r.legacyExamAt, 'תאריך מבחן מהגרסה הקודמת נשלח עם זמן 1970 ויימחק על ידי מכשיר אחר');

  const set = JSON.parse(await win.eval(`(function(){
    const realRest = rest, save = {AUTH:AUTH, UID:UID, store:store};
    AUTH = __session('uD'); UID = 'uD'; store = defaultSettings(); store.rounds = 3; store.dirty = true;
    const bodies = [];
    rest = function(path, init){ bodies.push(JSON.parse(init.body)); return Promise.resolve({ok:true}); };
    pushingSettings = null; settingsAgain = false;
    return pushSettings().then(function(){
      rest = realRest;
      const out = {hasExam: 'exam_date' in bodies[0]};
      store = defaultSettings();
      const m = __mock(function(){ return {status:200, body:[{exam_date:'2027-05-05', rounds:1, updated_at:new Date(0).toISOString()}]}; });
      return pullSettings().then(function(){
        m.restore();
        out.learned = store.examDate === '2027-05-05';
        localStorage.removeItem('bio-quiz-v2:uD');
        AUTH = save.AUTH; UID = save.UID; store = save.store;
        return JSON.stringify(out);
      });
    });
  })()`));
  check(!set.hasExam, 'מכשיר שלא ידע תאריך שלח exam_date ריק — ימחק את התאריך בשרת');
  check(set.learned, 'מכשיר חדש לא קיבל את תאריך המבחן מהשרת');
}

/* 5ac — שתי לשוניות מרעננות יחד: השנייה מאמצת, ולא מבטלת את המפגש המשותף */
{
  const r = JSON.parse(await win.eval(`(function(){
    const save = AUTH, realFetch = fetch;
    const exp = Math.floor(Date.now()/1000) - 10, good = Math.floor(Date.now()/1000) + 3600;
    AUTH = {access:'h.' + btoa(JSON.stringify({exp:exp, sub:'uR2'})) + '.s', refresh:'rt0', uid:'uR2'};
    SESSION.refreshing = null;
    const calls = [];
    fetch = function(url){
      calls.push(String(url));
      if(String(url).indexOf('grant_type=refresh_token') > -1){
        /* בזמן הבקשה לשונית אחרת כבר סובבה, והאירוע שלה אומץ */
        AUTH = Object.assign({}, AUTH, {access:'h.' + btoa(JSON.stringify({exp:good, sub:'uR2'})) + '.s', refresh:'rt1-other'});
        return Promise.resolve({ok:true, json:function(){
          return Promise.resolve({access_token:'h.' + btoa(JSON.stringify({exp:good, sub:'uR2'})) + '.s', refresh_token:'rt1-mine'});
        }});
      }
      return Promise.resolve({ok:true, json:function(){ return Promise.resolve({}); }});
    };
    return doRefresh().then(function(res){
      fetch = realFetch;
      const out = {res:res, revoked:calls.some(function(u){ return u.indexOf('/logout') > -1; }),
                   kept:AUTH && AUTH.refresh};
      AUTH = save;
      return JSON.stringify(out);
    });
  })()`));
  check(r.res === 'ok', 'רענון שלשונית אחרת כבר ביצעה לא נחשב הצלחה: ' + r.res);
  check(!r.revoked, 'רענון כפול ביטל את המפגש המשותף — כל הלשוניות יתנתקו');
  check(r.kept === 'rt1-other', 'הטוקן שאומץ מהלשונית האחרת נדרס');
}

/* 5ad — חזרה מגוגל: בלי חותמת מקומית נדחית עם הסבר; החותמת נצרכת גם בחזרה בלי טוקנים */
{
  const load = async (hash, stamp) => {
    const w = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      url: 'https://shassaf.github.io/shinun-yeda/' + hash,
      beforeParse(x) {
        x.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        x.scrollTo = () => {};
        x.fetch = () => Promise.reject(new Error('אין רשת בבדיקה'));
        if (stamp) x.localStorage.setItem('shinun-signin', JSON.stringify({ t: Date.now() }));
      },
    });
    await new Promise((res) => w.window.addEventListener('load', res, { once: true }));
    const out = JSON.parse(w.window.eval(`JSON.stringify({
      auth: !!AUTH, uid: AUTH && AUTH.uid, err: view.lockErr || null,
      stamp: localStorage.getItem('shinun-signin') !== null, hash: location.hash })`));
    tearingDown = true; w.window.close(); await new Promise((res) => setTimeout(res, 0)); tearingDown = false;
    return out;
  };
  const good = Math.floor(Date.now() / 1000) + 3600;
  const tok = 'h.' + Buffer.from(JSON.stringify({ exp: good, sub: 'u-oauth', email: 'o@t' })).toString('base64') + '.s';
  const noStamp = await load('#access_token=' + tok + '&refresh_token=r', false);
  check(!noStamp.auth && !!noStamp.err, 'טוקנים בלי חותמת התקבלו, או נדחו בלי הסבר');
  check(noStamp.hash === '', 'הטוקנים נשארו בכתובת');
  const ok = await load('#access_token=' + tok + '&refresh_token=r', true);
  check(ok.auth && ok.uid === 'u-oauth' && !ok.stamp, 'התחברות תקינה נדחתה, או שהחותמת לא נצרכה');
  const cancelled = await load('#error=access_denied&error_description=cancelled', true);
  check(!cancelled.auth && !cancelled.stamp && !!cancelled.err, 'ביטול ההתחברות השאיר חותמת פתוחה או בלי הודעה');
}

/* 5ae — ניהול: אישור לגרסה שנראתה; "לא נמצא" אינו "חסרה מיגרציה"; נושא שממתין לאישור
   חוזר עדיין ניתן להסרה אצל המנוי; חזרה "מוקדמת" לא נחשבת ישנה */
{
  const r = JSON.parse(await win.eval(`(function(){
    const save = {AUTH:AUTH, UID:UID, sl:syncLibrary, fs:fetchStore, fr:fetchReviewStatus, subs:LIB.subs, rows:LIB.rows};
    AUTH = Object.assign(__session('uAd'), {admin:true}); UID = 'uAd';
    const out = {};
    let m = __mock(function(req){
      if(req.url.indexOf('admin_review_deck') > -1) return {status:404, text:'{"code":"PT404","message":"החבילה לא נמצאה"}'};
      return {status:200, body:[]};
    });
    return rpcJson('admin_review_deck', {p_deck:'x', p_verdict:'approved', p_note:null, p_seen:'2026-01-01T00:00:00+00:00'})
      .then(function(){ out.pt404 = 'resolved'; }, function(e){ out.pt404 = e.message; })
      .then(function(){
        m.restore();
        /* לחיצה על "אשר" שולחת את הגרסה שהוצגה */
        view = {name:'admin', tab:'queue', loading:false, loaded:true, decks:[
          {id:'q1', title:'ממתין', review_status:'pending', visibility:'public', owner_email:'a@b', item_count:4,
           updated_at:'2026-09-01T10:00:00.123456+00:00'}]};
        renderNow();
        m = __mock(function(req){
          return req.url.indexOf('admin_review_deck') > -1 ? {status:200, body:'approved'} : {status:200, body:[]};
        });
        document.querySelector('[data-approve]').click();
        return new Promise(function(res){ setTimeout(res, 30); });
      }).then(function(){
        const call = m.sent.filter(function(x){ return x.url.indexOf('admin_review_deck') > -1; })[0];
        out.seen = call ? call.body.p_seen : null;
        m.restore();
        /* מנוי לנושא שממתין לאישור חוזר */
        LIB.subs = ['p9'];
        LIB.rows = [{id:'p9', owner_id:'o', kind:'topic', title:'נערך', visibility:'public', item_count:4, data:[]}];
        syncLibrary = function(){ return Promise.resolve({ok:true}); };
        fetchStore = function(){ return Promise.resolve({ok:true, data:[]}); };
        fetchReviewStatus = function(){ return Promise.resolve({}); };
        openStore();
        return new Promise(function(res){ setTimeout(res, 30); });
      }).then(function(){
        renderNow();
        const b = document.querySelector('[data-sub="p9"]');
        out.unsub = b ? b.textContent.trim() : '';
        syncLibrary = save.sl; fetchStore = save.fs; fetchReviewStatus = save.fr;
        LIB.subs = save.subs; LIB.status = 'ok'; LIB.rows = localRows(); applyRows();
        storageKeys().filter(function(k){ return /:uAd$/.test(k); }).forEach(jremove);
        /* חזרה אחרי מצב שנחתם בשעון שמקדים */
        const deck = DECKS[0], it = deck.items[0], key = deck.keyFn(it);
        const was = CARDS[key];
        CARDS[key] = {s:3, d:5, due:Date.now() + 1e8, last:Date.now() + 300000, reps:2, lapses:0};
        const q = {key:key};
        __quiet();
        scheduleReview(q, 3, 5000);
        out.monotonic = CARDS[key].last > Date.now() + 299000 && CARDS[key].reps === 3;
        if(was) CARDS[key] = was; else delete CARDS[key];
        delete DIRTY[key]; LOGQ = LOGQ.filter(function(e){ return e.card_key !== key; });
        __quiet();
        AUTH = save.AUTH; UID = save.UID; ADMIN.seen = {}; quiz = null; view = {name:'home'}; renderNow();
        return JSON.stringify(out);
      });
  })()`));
  check(r.pt404 === 'החבילה לא נמצאה', '404 אמיתי מדווח כמיגרציה חסרה: ' + r.pt404);
  check(r.seen === '2026-09-01T10:00:00.123456+00:00', 'האישור לא נשלח עם הגרסה שהוצגה: ' + r.seen);
  check(r.unsub === 'הסר', 'אי אפשר להסיר נושא שממתין לאישור חוזר');
  check(r.monotonic, 'חזרה אחרי מצב מ"שעון מקדים" נחתמה כישנה ותידחה בשרת');
}

/* 5af — רענון יזום באמת מרענן; יציאה מבטלת את המפגש גם כשהטוקן פג;
   כתיבת המפגש לא מחזירה לדיסק טוקן ישן מזה שלשונית אחרת שמרה */
{
  const r = JSON.parse(await win.eval(`(function(){
    const save = AUTH, realFetch = fetch, savedDisk = localStorage.getItem('shinun-auth');
    const now = Math.floor(Date.now()/1000);
    const tok = function(exp, sub){ return 'h.' + btoa(JSON.stringify({exp:exp, sub:sub || 'uZ'})) + '.s'; };
    const out = {};
    let calls = [];
    fetch = function(url){
      calls.push(String(url));
      return Promise.resolve({ok:true, json:function(){
        return Promise.resolve({access_token:tok(now + 3600), refresh_token:'r-new'});
      }});
    };
    SESSION.refreshing = null;
    AUTH = {access:tok(now + 100), refresh:'r-old', uid:'uZ'};
    return ensureToken('soon').then(function(){
      out.soonRefreshed = calls.filter(function(u){ return u.indexOf('refresh_token') > -1; }).length === 1;
      calls = [];
      AUTH = {access:tok(now + 3000), refresh:'r-old', uid:'uZ'};
      return ensureToken('soon');
    }).then(function(){
      out.soonSkipsFresh = calls.length === 0;
      /* יציאה עם טוקן שפג: רענון ואז ביטול עם הטוקן החדש */
      calls = [];
      AUTH = {access:tok(now - 30), refresh:'r-old', uid:'uZ', email:'z@t'};
      signOut();
      return new Promise(function(res){ setTimeout(res, 30); });
    }).then(function(){
      out.revokeFresh = calls.length === 2 && calls[0].indexOf('refresh_token') > -1 && calls[1].indexOf('/logout') > -1;
      /* authWrite: בדיסק טוקן חדש יותר של אותו משתמש */
      localStorage.setItem('shinun-auth', JSON.stringify({access:tok(now + 3500), refresh:'r-disk', uid:'uZ'}));
      const mem = {access:tok(now + 100), refresh:'r-mem', uid:'uZ', admin:true};
      authWrite(mem);
      const disk = JSON.parse(localStorage.getItem('shinun-auth'));
      out.keptNewer = disk.refresh === 'r-disk' && mem.refresh === 'r-disk' && disk.admin === true;
      fetch = realFetch; AUTH = save;
      if(savedDisk) localStorage.setItem('shinun-auth', savedDisk); else localStorage.removeItem('shinun-auth');
      /* signOut ניתק את המשתמש מהזיכרון — מחזירים את מצב הבדיקה */
      bindUser(authUid());
      LIB.status = 'ok'; LIB.rows = localRows(); applyRows();
      quiz = null; view = {name:'home'}; renderNow();
      return JSON.stringify(out);
    });
  })()`));
  check(r.soonRefreshed, 'הרענון היזום לא מרענן טוקן שנשארו לו פחות משתי דקות וחצי');
  check(r.soonSkipsFresh, 'הרענון היזום מרענן טוקן שעוד רחוק מפקיעה');
  check(r.revokeFresh, 'יציאה עם טוקן שפג לא ביטלה את המפגש בשרת');
  check(r.keptNewer, 'כתיבת המפגש החזירה לדיסק טוקן רענון ישן');
}

/* 5ag — איחוד נושאים: רק מאותו סוג; הבקשה נשלחת ליעד הנבחר עם מה שסומן;
   ההתקדמות המקומית ויומן החזרות עוברים לפי המפה שהשרת החזיר */
{
  const r = JSON.parse(await win.eval(`(function(){
    const save = {AUTH:AUTH, UID:UID, sl:syncLibrary, fs:fetchStore, fr:fetchReviewStatus, subs:LIB.subs,
                  rows:LIB.rows, conf:window.confirm, CARDS:CARDS, DIRTY:DIRTY, LOGQ:LOGQ};
    AUTH = __session('uM'); UID = 'uM';
    CARDS = {}; DIRTY = {}; LOGQ = [];
    const out = {};
    const t = function(id, title, kind, owner){ return {id:id, owner_id:owner || 'uM', kind:kind || 'topic', title:title,
                                                        visibility:'private', item_count:4, data:[]}; };
    out.cands = mergeCandidates(t('t1','א'), [t('t1','א'), t('t2','ב'), t('g1','ג','groups')],
                                [t('p1','ד','topic','o'), t('i1','ה','iso','o')]).map(function(d){ return d.id; }).join();
    out.iso = mergeCandidates(t('i2','ו','iso'), [t('i2','ו','iso'), t('i3','ז','iso')], []).length;

    LIB.subs = ['p1'];
    LIB.rows = [t('t1','ראשון'), t('t2','שני'), t('g1','קבוצות','groups'), t('p1','ציבורי','topic','o')];
    syncLibrary = function(){ return Promise.resolve({ok:true}); };
    fetchStore = function(){ return Promise.resolve({ok:true, data:[
      {id:'p1', kind:'topic', title:'ציבורי', item_count:5, visibility:'public', owner_id:'o'}]}); };
    fetchReviewStatus = function(){ return Promise.resolve({}); };
    lastPaintError = null;
    openStore();
    return new Promise(function(res){ setTimeout(res, 40); }).then(function(){
      renderNow();
      const open = document.getElementById('mgOpen');
      out.offered = !!open;
      open.click(); renderNow();
      out.targets = Array.from(document.querySelectorAll('#mgInto option')).map(function(o){ return o.value; }).join();
      out.list = Array.from(document.querySelectorAll('[data-mg]')).map(function(c){ return c.dataset.mg; }).join();
      out.idle = document.getElementById('mgGo').disabled;
      /* סימון בסדר הפוך מהרשימה — זה הסדר שנשלח */
      document.querySelector('[data-mg="p1"]').click(); renderNow();
      document.querySelector('[data-mg="t2"]').click(); renderNow();
      out.label = document.getElementById('mgGo').textContent;

      CARDS['t2:a'] = {s:3, d:5, due:Date.now() + 1e8, last:Date.now() - 1000, reps:2, lapses:0};
      CARDS['t1:x'] = {s:9, d:4, due:Date.now() + 1e9, last:Date.now() - 5000, reps:5, lapses:0};
      CARDS['p1:x'] = {s:1, d:6, due:Date.now() + 1e7, last:Date.now() - 100, reps:1, lapses:1};
      LOGQ.push({id:'L1', card_key:'t2:a', rating:3});
      window.confirm = function(msg){ out.confirm = msg; return true; };
      const m = __mock(function(req){
        if(req.url.indexOf('rpc/merge_decks') > -1)
          return {status:200, body:{into:'t1', added:2, merged:2, deleted:1,
                                    map:{'t2:a':'t1:a-2', 'p1:x':'t1:x'}}};
        return {status:200, body:[]};
      });
      document.getElementById('mgGo').click();
      return new Promise(function(res){ setTimeout(res, 60); }).then(function(){
        const call = m.sent.filter(function(x){ return x.url.indexOf('rpc/merge_decks') > -1; })[0];
        out.body = call ? call.body.p_into + '|' + call.body.p_from.join() : null;
        /* אחרי האיחוד הכול נשלח מיד — בודקים את מה שיצא לשרת */
        const keys = function(table){
          return [].concat.apply([], m.sent.filter(function(x){ return x.method === 'POST' && x.url.indexOf(table) > -1; })
                                         .map(function(x){ return x.body || []; }))
                   .map(function(x){ return x.card_key; });
        };
        out.moved = !!CARDS['t1:a-2'] && !CARDS['t2:a'] && keys('card_state').indexOf('t1:a-2') > -1;
        out.newer = CARDS['t1:x'] && CARDS['t1:x'].reps === 1 && !CARDS['p1:x'];
        /* מה שחיכה נשלח לפני האיחוד, תחת המפתח הישן — והשרת מעביר אותו */
        const at = function(part){ return m.sent.map(function(x){ return x.url; })
                                             .findIndex(function(u){ return u.indexOf(part) > -1; }); };
        out.flushed = at('review_log') > -1 && at('review_log') < at('rpc/merge_decks') &&
                      keys('review_log').join() === 't2:a';
        /* ומה שעוד לא נשלח עובר מקומית */
        LOGQ = [{id:'L2', card_key:'t2:b', rating:2}];
        moveCardKeys(function(k){ return k === 't2:b' ? 't1:b' : null; });
        out.log = LOGQ[0].card_key === 't1:b';
        LOGQ = [];
        renderNow();
        out.note = (document.querySelector('.diag-report') || {}).textContent || '';
        out.closed = !document.getElementById('mgGo');
        m.restore();

        /* לפני מיגרציה 0007 — הודעה שמפנה אליה */
        const m2 = __mock(function(req){
          return req.url.indexOf('rpc/') > -1 ? {status:404, text:'{"code":"PGRST202","message":"x"}'} : {status:200, body:[]};
        });
        return mergeDecks('t1', ['t2']).then(function(){ out.missing = 'resolved'; },
                                             function(e){ out.missing = e.message; })
          .then(function(){ m2.restore(); });
      });
    }).then(function(){
      out.crash = lastPaintError;
      window.confirm = save.conf;
      syncLibrary = save.sl; fetchStore = save.fs; fetchReviewStatus = save.fr;
      storageKeys().filter(function(k){ return /:uM$/.test(k); }).forEach(jremove);
      CARDS = save.CARDS; DIRTY = save.DIRTY; LOGQ = save.LOGQ; __quiet();
      AUTH = save.AUTH; UID = save.UID; LIB.subs = save.subs;
      LIB.status = 'ok'; LIB.rows = save.rows; applyRows();
      quiz = null; view = {name:'home'}; renderNow();
      return JSON.stringify(out);
    });
  })()`));
  check(r.cands === 't2,p1', 'מועמדים לאיחוד שגויים (רק אותו סוג, בלי היעד): ' + r.cands);
  check(r.iso === 0, 'עץ האיזומרים מוצע לאיחוד');
  check(r.offered, 'אין כפתור איחוד במאגר');
  check(r.targets === 't1,t2', 'יעדי האיחוד שגויים: ' + r.targets);
  check(r.list === 't2,p1', 'רשימת מה לצרף שגויה: ' + r.list);
  check(r.idle, 'אפשר לאחד בלי לסמן כלום');
  check(r.label === 'אחד 3 נושאים', 'תווית כפתור האיחוד שגויה: ' + r.label);
  check(/"שני" יימחקו/.test(r.confirm || '') && /"ציבורי" — הכרטיסים יועתקו/.test(r.confirm || ''),
    'האישור לא מבחין בין נושא שלי שיימחק לנושא של אחר שיועתק: ' + r.confirm);
  check(r.body === 't1|p1,t2', 'בקשת האיחוד שגויה: ' + r.body);
  check(r.moved, 'ההתקדמות המקומית לא עברה למפתח החדש');
  check(r.newer, 'בהתנגשות לא נשאר המצב עם החזרה המאוחרת');
  check(r.flushed, 'יומן החזרות הממתין לא נשלח לפני האיחוד');
  check(r.log, 'יומן החזרות הממתין לא עבר למפתח החדש');
  check(/אוחדו 2 נושאים/.test(r.note) && /נוספו 2/.test(r.note), 'אין סיכום אחרי האיחוד: ' + r.note);
  check(r.closed, 'חלון האיחוד נשאר פתוח אחרי ההצלחה');
  check(/0007/.test(r.missing || ''), 'איחוד בלי המיגרציה לא מפנה ל-0007: ' + r.missing);
  check(!r.crash, 'המאגר קרס באיחוד: ' + r.crash);
}

/* 5ah — ניהול: מחיקה מלאה של נושא, ומחיקה גורפת של הציבוריים של אחרים
   בלבד; לפני 0007 — נופלת למחיקה רגילה */
{
  const r = JSON.parse(await win.eval(`(function(){
    const save = {AUTH:AUTH, UID:UID, conf:window.confirm, sl:syncLibrary};
    AUTH = Object.assign(__session('uA'), {admin:true}); UID = 'uA';
    syncLibrary = function(){ return Promise.resolve({ok:true}); };
    const out = {};
    const decks = [
      {id:'mine', title:'שלי', review_status:'approved', visibility:'public', owner_id:'uA', item_count:4},
      {id:'o1', title:'אחר', review_status:'approved', visibility:'public', owner_id:'x', item_count:4},
      {id:'o2', title:'ממתין', review_status:'pending', visibility:'public', owner_id:'y', item_count:4},
      {id:'o3', title:'נדחה', review_status:'rejected', visibility:'private', owner_id:'z', item_count:4}];
    out.pick = purgeable(decks).map(function(d){ return d.id; }).join();
    let m = __mock(function(req){
      if(req.url.indexOf('rpc/admin_purge_decks') > -1) return {status:200, body:req.body.p_decks.length};
      if(req.url.indexOf('rpc/admin_moderation') > -1) return {status:200, body:decks};
      return {status:200, body:[]};
    });
    view = {name:'admin', tab:'public', loading:false, loaded:true, decks:decks};
    renderNow();
    out.bulk = !!document.getElementById('purgeAll');
    window.confirm = function(msg){ if(!out.confirm) out.confirm = msg; return true; };
    document.getElementById('purgeAll').click();
    return new Promise(function(res){ setTimeout(res, 40); }).then(function(){
      const call = m.sent.filter(function(x){ return x.url.indexOf('admin_purge_decks') > -1; })[0];
      out.sent = call ? call.body.p_decks.join() : null;
      m.restore();
      view = {name:'admin', tab:'public', loading:false, loaded:true, decks:decks};
      renderNow();
      m = __mock(function(req){
        if(req.url.indexOf('rpc/admin_purge_decks') > -1) return {status:200, body:1};
        if(req.url.indexOf('rpc/admin_moderation') > -1) return {status:200, body:decks};
        return {status:200, body:[]};
      });
      document.querySelector('[data-adel="o3"]').click();
      return new Promise(function(res){ setTimeout(res, 40); });
    }).then(function(){
      const call = m.sent.filter(function(x){ return x.url.indexOf('admin_purge_decks') > -1; })[0];
      out.one = call ? call.body.p_decks.join() : null;
      m.restore();
      /* לפני 0007: מחיקה רגילה דרך ה-REST */
      m = __mock(function(req){
        if(req.url.indexOf('rpc/') > -1) return {status:404, text:'{"code":"PGRST202","message":"x"}'};
        if(req.method === 'DELETE') return {status:200, body:[{id:'o1'}]};
        return {status:200, body:[]};
      });
      return purgeDecks(['o1']).then(function(n){
        out.fallback = n + '|' + m.sent.filter(function(x){ return x.method === 'DELETE'; })
                                       .map(function(x){ return x.url.split('?')[1]; }).join();
        m.restore();
      });
    }).then(function(){
      out.crash = lastPaintError;
      window.confirm = save.conf; syncLibrary = save.sl;
      AUTH = save.AUTH; UID = save.UID; ADMIN.pending = 0;
      quiz = null; view = {name:'home'}; renderNow();
      return JSON.stringify(out);
    });
  })()`));
  check(r.pick === 'o1,o2', 'המחיקה הגורפת תופסת משהו מלבד הציבוריים של אחרים: ' + r.pick);
  check(r.bulk, 'אין כפתור מחיקה גורפת בלשונית הציבוריות');
  check(/2 נושאים ציבוריים/.test(r.confirm || '') && /הנושאים שלך לא נמחקים/.test(r.confirm || ''),
    'האישור למחיקה הגורפת לא ברור: ' + r.confirm);
  check(r.sent === 'o1,o2', 'המחיקה הגורפת שלחה נושאים שגויים: ' + r.sent);
  check(r.one === 'o3', 'מחיקה של נושא בודד לא עוברת דרך המחיקה המלאה: ' + r.one);
  check(r.fallback === '1|id=eq.o1', 'בלי 0007 המחיקה לא נופלת למחיקה רגילה: ' + r.fallback);
  check(!r.crash, 'מסך הניהול קרס במחיקה: ' + r.crash);
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

  /* ה-SW מדווח את חתימת הדף שהוא מגיש — אותה חתימה שבדף עצמו */
  const pageBuild = (html.match(/<meta name="app-build" content="([^"]+)"/) || [])[1];
  let told = null;
  handlers.message && handlers.message({ data: { type: 'page-build' }, ports: [{ postMessage: (v) => { told = v; } }] });
  check(!!pageBuild && told === pageBuild, `ה-SW דיווח חתימה ${told} במקום ${pageBuild}`);
}

/* SW חדש שתפס שליטה: טעינה מחדש רק כשהדף באמת ישן, ולא באמצע סנכרון.
   אחרי כל דיפלוי הדף החדש כבר נטען ברשת-תחילה, וה-SW החדש שתפס שליטה
   שניות אחר כך טען אותו מחדש — קטע את הסנכרון ורשם Failed to fetch. */
{
  const tail = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
  check(tail.indexOf('controllerchange') > -1, 'לא נמצא סקריפט רישום ה-SW');
  const pageBuild = (html.match(/<meta name="app-build" content="([^"]+)"/) || [])[1];

  const run = async (answer, busy) => {
    let onChange = null, reloads = 0;
    const timers = [];
    const sandbox = {
      navigator: { serviceWorker: {
        controller: { postMessage: (msg, ports) => {
          if (answer !== undefined && msg && msg.type === 'page-build') ports[0].postMessage(answer);
        } },
        register: () => Promise.resolve(),
        addEventListener: (t, fn) => { if (t === 'controllerchange') onChange = fn; },
      } },
      location: { protocol: 'https:', reload: () => { reloads++; } },
      document: { querySelector: (s) => (s.indexOf('app-build') > -1 ? { content: pageBuild } : null) },
      addEventListener: () => {},
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeout: () => {},
      /* לא זה של Node — פורט פתוח שלו מחזיק את התהליך בחיים */
      MessageChannel: function () {
        const port1 = {};
        this.port1 = port1;
        this.port2 = { postMessage: (v) => Promise.resolve().then(() => port1.onmessage && port1.onmessage({ data: v })) };
      },
      quiz: null, syncingAll: busy ? {} : null, cardSync: null, leaving: false,
    };
    vm.runInNewContext(tail, sandbox);
    onChange();                                 /* הראשון אחרי ביקור עם SW — גרסה חדשה */
    await new Promise((r) => setTimeout(r, 20));
    /* בלי תשובה — רק שעון החסות של 3 שניות מכריע */
    const guard = timers.find((t) => t.ms === 3000);
    if (answer === undefined && guard) { guard.fn(); await new Promise((r) => setTimeout(r, 0)); }
    return { reloads, leaving: sandbox.leaving, deferred: timers.some((t) => t.ms === 5000) };
  };

  const same = await run(pageBuild);
  check(same.reloads === 0, 'SW של אותה בנייה טען את הדף מחדש');
  const older = await run('0000deadbeef');
  check(older.reloads === 1, 'SW של בנייה חדשה לא טען את הדף הישן מחדש');
  check(older.leaving === true, 'טעינה מחדש לא סימנה שהדף יוצא — הבקשות שנקטעות יירשמו');
  const silent = await run(undefined);
  check(silent.reloads === 1, 'SW שלא ענה לא גרם לטעינה מחדש (נפילה להתנהגות הקודמת)');
  const syncing = await run('0000deadbeef', true);
  check(syncing.reloads === 0 && syncing.deferred, 'טעינה מחדש לא חיכתה לסנכרון שבטיסה');
}

check(win.eval('lastPaintError') === null, 'מסך קרס במהלך הבדיקות: ' + win.eval('lastPaintError'));

dom.window.close();

reported = true;
if (fail.length) {
  console.error('בדיקת העשן נכשלה:\n' + [...new Set(fail)].map((f) => '  · ' + f).join('\n'));
  process.exit(1);
}
console.log('בדיקת העשן עברה — %d חבילות, %d פריטים',
  DECKS.length, DECKS.reduce((a, d) => a + d.items.length, 0));
