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
      /* סבב חייב להיות באורך המבוקש כשיש מספיק פריטים */
      const want = Math.min(12, deck.items.length);
      if (qs.length < want && mode.id !== 'pair') {
        fail.push(`${deck.id}/${mode.id}: ${qs.length} שאלות במקום ${want}`);
        break;
      }
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
  check(document.querySelectorAll('[data-pub]').length === 2, 'אין כפתורי פרסום לחבילות שלי');
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
  const src = win.eval('refreshToken.toString()');
  check(src.indexOf('Object.assign({}, AUTH') > -1,
    'רענון בונה את הזהות מחדש ומוחק את uid');
  check(src.indexOf('lockErr') > -1, 'כישלון רענון לא מחזיר למסך התחברות');

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
            if(q.optionKind === 'pic'){
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
  locked.window.close();
}

dom.window.close();

if (fail.length) {
  console.error('בדיקת העשן נכשלה:\n' + [...new Set(fail)].map((f) => '  · ' + f).join('\n'));
  process.exit(1);
}
console.log('בדיקת העשן עברה — %d חבילות, %d פריטים',
  DECKS.length, DECKS.reduce((a, d) => a + d.items.length, 0));
