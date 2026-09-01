/**
 * add-question — מקבל בקשה בשפה חופשית (וגם צילומי שקפים), מבקש מ-Claude
 * פריט תוכן תקין, מאמת אותו מול הסכימה, וכותב ישירות לטבלת decks.
 *
 * הכתיבה נעשית עם הטוקן של המשתמש, כך ש-RLS אוכף בעלות — הפונקציה אינה
 * יכולה לגעת בנושא שאינו שלו. אין commit, אין בנייה, והשינוי מיידי.
 *
 * משתני סביבה נדרשים (supabase secrets set):
 *   ANTHROPIC_API_KEY   מפתח ה-API
 *   ALLOWED_EMAILS      מי רשאי לערוך
 *   APP_PASSPHRASE      מסלול חירום ללא התחברות
 *   MODEL               אופציונלי, ברירת מחדל claude-opus-5
 */
import Anthropic from 'npm:@anthropic-ai/sdk@0.71.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* חלקי התוכן שאפשר לערוך בתוך נושא, לפי סוגו */
const SECTIONS = ['items', 'iso', 'isoTerms', 'isoPairs'] as const;
const DECK_KEYS = ['groups', 'elements', 'iso', 'isoTerms', 'isoPairs', 'topics'] as const;
type DeckKey = typeof DECK_KEYS[number];

const REL_KEYS = ['chain', 'position', 'functional', 'geometric',
  'enantiomers', 'diastereomers', 'conformers', 'same'];
const GROUP_CATS = ['hc', 'ox', 'n', 's', 'p'];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/* השוואה בזמן קבוע — לא מדליפה את אורך ההתאמה */
function safeEqual(a: string, b: string) {
  const ab = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/* ---------- אימות ---------- */

function isMolecule(m: unknown, path: string, errs: string[]) {
  const mol = m as { a?: unknown[]; b?: unknown[] };
  if (!mol || !Array.isArray(mol.a) || !Array.isArray(mol.b)) {
    errs.push(`${path}: חסר a/b`); return;
  }
  if (!mol.a.length) { errs.push(`${path}.a ריק`); return; }
  for (const [i, at] of mol.a.entries()) {
    const atom = at as { t?: unknown; x?: unknown; y?: unknown };
    if (typeof atom?.t !== 'string' || !atom.t.length)
      errs.push(`${path}.a[${i}].t חייב להיות מחרוזת`);
    if (typeof atom?.x !== 'number' || typeof atom?.y !== 'number')
      errs.push(`${path}.a[${i}] קואורדינטות חייבות להיות מספרים`);
  }
  for (const [i, bd] of mol.b.entries()) {
    if (!Array.isArray(bd) || bd.length !== 3) {
      errs.push(`${path}.b[${i}] חייב להיות [i,j,order]`); continue;
    }
    const [x, y, order] = bd as number[];
    if (!Number.isInteger(x) || x < 0 || x >= mol.a.length) errs.push(`${path}.b[${i}] אינדקס ${x} מחוץ לתחום`);
    if (!Number.isInteger(y) || y < 0 || y >= mol.a.length) errs.push(`${path}.b[${i}] אינדקס ${y} מחוץ לתחום`);
    if (![1, 2, 3, 4].includes(order)) errs.push(`${path}.b[${i}] order חייב 1-4`);
  }
}

function str(o: Record<string, unknown>, k: string, path: string, errs: string[]) {
  if (typeof o[k] !== 'string' || !(o[k] as string).trim())
    errs.push(`${path}.${k} חסר`);
}

function validateItem(deck: DeckKey, item: Record<string, unknown>, i: number, errs: string[]) {
  const path = `${deck}[${i}]`;
  str(item, 'id', path, errs);
  if (typeof item.id === 'string' && !/^[a-z0-9][a-z0-9-]{1,40}$/.test(item.id))
    errs.push(`${path}.id חייב להיות slug באנגלית קטנה`);

  if (deck === 'groups') {
    str(item, 'en', path, errs); str(item, 'he', path, errs);
    if (!GROUP_CATS.includes(item.cat as string)) errs.push(`${path}.cat חייב אחד מ-${GROUP_CATS}`);
    isMolecule(item, path, errs);
  } else if (deck === 'elements') {
    str(item, 'sym', path, errs); str(item, 'en', path, errs);
    str(item, 'he', path, errs); str(item, 'role', path, errs);
    if (item.sym !== item.id) errs.push(`${path}: id חייב להיות זהה ל-sym`);
    if (!['bulk', 'trace'].includes(item.cat as string)) errs.push(`${path}.cat חייב bulk או trace`);
  } else if (deck === 'iso') {
    str(item, 'he', path, errs); str(item, 'en', path, errs);
    str(item, 'def', path, errs); str(item, 'color', path, errs);
    if (typeof item.depth !== 'number') errs.push(`${path}.depth חייב מספר`);
    if (item.parent !== null && typeof item.parent !== 'string') errs.push(`${path}.parent חייב id או null`);
  } else if (deck === 'isoTerms') {
    str(item, 'he', path, errs); str(item, 'en', path, errs); str(item, 'def', path, errs);
  } else if (deck === 'isoPairs') {
    str(item, 'label', path, errs); str(item, 'why', path, errs);
    if (!REL_KEYS.includes(item.rel as string)) errs.push(`${path}.rel חייב אחד מ-${REL_KEYS}`);
    isMolecule(item.A, `${path}.A`, errs);
    isMolecule(item.B, `${path}.B`, errs);
  } else if (deck === 'topics') {
    /* כרטיס בנושא חופשי: מושג מול הסבר */
    str(item, 'front', path, errs);
    str(item, 'back', path, errs);
  }
}

const MAX_CARDS = 200;
const MAX_FILES = 6;
/* התקרה של ה-API היא 32MB לבקשה ו-600 עמודים למסמך. אנחנו נמוכים
   מזה בהרבה, כי base64 מנפח ב-33% ולפונקציה יש תקרת גוף משלה. */
const MAX_TOTAL_B64 = 14_000_000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const DOC_TYPES = ['application/pdf'];
const MAX_TURNS = 20;

function validateTopic(item: Record<string, unknown>, i: number, errs: string[]) {
  const path = `topics[${i}]`;
  str(item, 'title', path, errs);
  const cards = item.cards;
  if (!Array.isArray(cards) || !cards.length) { errs.push(`${path}.cards ריק`); return; }
  if (cards.length > MAX_CARDS) errs.push(`${path}.cards יותר מ-${MAX_CARDS} כרטיסים`);
  const seen = new Set<string>();
  cards.forEach((c, j) => {
    const card = c as Record<string, unknown>;
    const cp = `${path}.cards[${j}]`;
    if (typeof card.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(card.id))
      errs.push(`${cp}.id חייב להיות slug באנגלית קטנה`);
    else if (seen.has(card.id)) errs.push(`${cp}.id כפול`);
    else seen.add(card.id);
    str(card, 'front', cp, errs);
    str(card, 'back', cp, errs);
  });
}

/* עריכת תווית ממשק — רק מפתחות שכבר קיימים, ורק מחרוזות */
function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}
function setPath(obj: Record<string, unknown>, path: string, value: string) {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (const k of parts.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[parts.at(-1)!] = value;
}
function validateLabel(ui: unknown, item: Record<string, unknown>, i: number, errs: string[]) {
  const path = `ui[${i}]`;
  if (typeof item.path !== 'string' || !item.path) { errs.push(`${path}.path חסר`); return; }
  if (typeof item.value !== 'string' || !item.value.trim()) { errs.push(`${path}.value חסר`); return; }
  if ((item.value as string).length > 200) errs.push(`${path}.value ארוך מדי`);
  if (typeof getPath(ui, item.path as string) !== 'string')
    errs.push(`${path}: הנתיב "${item.path}" אינו תווית קיימת`);
}


/* ---------- אימות ---------- */
/* טוקן גוגל דרך Supabase, או סיסמה כגיבוי. ALLOWED_EMAILS חובה לזרימת הטוקן —
   בלעדיו כל חשבון גוגל בעולם היה מורשה, ולכן נכשלים סגור. */
async function authorize(req: Request, body: { passphrase?: string }, pass: string) {
  const bearer = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) {
    const url = Deno.env.get('SUPABASE_URL')?.trim();
    const anon = Deno.env.get('SUPABASE_ANON_KEY')?.trim();
    if (!url || !anon) return { ok: false, editor: false, msg: 'הגדרות Supabase חסרות בפונקציה' };
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${bearer}` },
    });
    if (!r.ok) return { ok: false, editor: false, msg: 'ההתחברות פגה. התחבר שוב.' };
    const user = await r.json() as { email?: string };
    const allowed = (Deno.env.get('ALLOWED_EMAILS') ?? '')
      .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    /* התחברות פתוחה לכולם; עריכה שמוציאה כסף או נוגעת בקוד — רק לרשימה */
    const editor = allowed.includes((user.email ?? '').toLowerCase());
    return { ok: true, editor, msg: editor ? '' : 'החשבון אינו מורשה לעריכה.' };
  }
  if (body.passphrase && safeEqual(body.passphrase, pass)) return { ok: true, editor: true, msg: '' };
  return { ok: false, editor: false, msg: 'נדרשת התחברות' };
}

/* ---------- הנחיה ל-Claude ---------- */

const SYSTEM = `אתה עורך התוכן של אפליקציית שינון, בעברית.
המשתמש מבקש להוסיף פריטים או לתקן קיימים. זו שיחה. אתה יכול לענות בטקסט — לשאול שאלת הבהרה, להציע מה לבנות, או
לדווח מה מצאת במסמך — וכשברור מה לעשות, אתה קורא לכלי propose_content.

מתי לענות בטקסט ומתי לקרוא לכלי:
- קובץ גדול או בקשה רחבה ("תבנה ממנו כרטיסיות") — קודם אמור בקצרה מה
  יש במסמך וכמה כרטיסים אתה מציע, ושאל אם להתקדם. אל תבנה עשרות
  כרטיסים בלי לוודא.
- בקשה ממוקדת וברורה — פשוט בצע וקרא לכלי.
- אחרי אישור של המשתמש — קרא לכלי בלי לשאול שוב.

כשמצורף PDF: קרא אותו, זהה את מה שבאמת נבחן — הגדרות, מנגנונים,
מספרים שצריך לזכור, יחסים בין מושגים. דלג על מבואות, ביבליוגרפיה
ותודות. אם המסמך ארוך, התמקד בעיקר וציין מה השארת בחוץ.

לכל נושא יש סוג (kind) שקובע את מבנה הפריטים שלו:

groups — קבוצה פונקציונלית. הפריטים במקטע "items":
  id (slug), en (שם אנגלי), he (שם עברי), cat (hc|ox|n|s|p),
  a — אטומים: [{"t":"C","x":1,"y":0}]  t היא התווית המוצגת (C, O, N, S, P, H, R, R¹, O⁻, N⁺, OH, CH₃ ...)
  b — קשרים: [[i,j,order]] אינדקסים למערך a. order: 1 יחיד, 2 כפול, 3 טריז, 4 מקווקו.

elements — יסוד. מקטע "items":
  id (זהה ל-sym), sym, en, he, cat (bulk|trace), role (תפקיד ביוכימי, משפט אחד בעברית)

iso — עץ האיזומרים. שלושה מקטעים נפרדים:
  "iso"      צומת בעץ: id, he, en, parent (id של צומת קיים), depth (מספר),
             color (מחרוזת CSS כמו "var(--c-o)"), def, ex
  "isoTerms" מושג נלווה: id, he, en, def, ex
  "isoPairs" זוג מבנים לזיהוי יחס: id, rel, label, A ו-B (כל אחד {"a":[...],"b":[...]}), why
             rel אחד מ: chain|position|functional|geometric|enantiomers|diastereomers|conformers|same

topic — נושא חופשי. מקטע "items", כרטיסים:
  id, front (המושג), frontSub (אופציונלי, בלועזית), back (ההסבר), note (אופציונלי)
  **זה היעד לכל נושא שאינו קבוצות פונקציונליות, יסודות או איזומריה** — ביולוגיה
  של התא, מסלולים מטבוליים, אנזימולוגיה, פרמקולוגיה, ויטמינים, הכול.
  אל תסרב בטענה שאין נושא מתאים. אם אין — target="new_topic" ותיצור אחד.

כללי ציור מולקולות:
- הרשת ביחידות של 1. קשר טיפוסי באורך 1 עד 1.5. תוויות ארוכות (CH₂OH) דורשות מרווח 1.5.
- x גדל ימינה, y גדל למטה.
- אל תמציא גיאומטריה מסובכת. שרשרת אופקית פשוטה עדיפה על טבעת שגויה.
- לטריז ומקווקו יש משמעות סטראוכימית — רק כשהיא רלוונטית.

אם צורפו תמונות, הן צילומי שקפים מהרצאה:
- חלץ את המושגים שנבחנים עליהם ובנה מהם פריטים.
- ברירת המחדל לשקף היא נושא חדש, אלא אם הוא מתאים לנושא קיים.
- אל תמציא מה שלא בשקף. משהו לא קריא — דלג עליו במקום לנחש.
- בין 4 ל-20 פריטים לפי מה שהשקף מצדיק.
- בקשה בטקסט גוברת על ברירות המחדל האלה.

כללים:
- id ייחודי, אותיות אנגליות קטנות ומקפים. אל תתנגש ב-id קיים אלא אם אתה
  מתקן פריט קיים, ואז mode="replace" ואותו id.
- טקסט למשתמש בעברית. שמות ומונחים לועזיים נשארים בלועזית.
- דיוק מדעי קודם לכל. בקשה שגויה עובדתית — תקן וציין זאת ב-summary.
- נושא חדש חייב ארבעה פריטים לפחות, אחרת אי אפשר לייצר ארבע אפשרויות.
- אם הבקשה אינה ברורה, החזר items ריק והסבר ב-summary.`;

const TOOL: Anthropic.Tool = {
  name: 'propose_content',
  description: 'מחזיר את הפריטים להוספה או להחלפה, ולאיזה נושא הם שייכים.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target: {
        type: 'string',
        enum: ['existing', 'new_topic'],
        description: 'existing כדי לערוך נושא קיים, new_topic כדי ליצור חדש',
      },
      deck_id:  { type: 'string', description: 'מזהה הנושא כשהיעד existing, אחרת מחרוזת ריקה' },
      new_title:    { type: 'string', description: 'כותרת הנושא החדש, אחרת מחרוזת ריקה' },
      new_subtitle: { type: 'string', description: 'תת־כותרת קצרה, אפשר ריק' },
      section: {
        type: 'string',
        enum: [...SECTIONS],
        description: 'items לרוב הנושאים. בנושא iso: iso, isoTerms או isoPairs',
      },
      mode: { type: 'string', enum: ['add', 'replace'], description: 'add להוספה, replace לתיקון לפי id' },
      items_json: { type: 'string', description: 'מערך JSON של הפריטים, כמחרוזת' },
      summary: { type: 'string', description: 'משפט אחד בעברית — מה נעשה' },
    },
    required: ['target', 'deck_id', 'new_title', 'new_subtitle', 'section', 'mode', 'items_json', 'summary'],
  },
};

/* ---------- PostgREST בשם המשתמש ---------- */
/* כל קריאה נושאת את הטוקן של המשתמש, ולכן RLS אוכף בעלות. הפונקציה
   אינה יכולה לגעת בנושא שאינו שלו גם אם Claude יבקש. */
type Deck = {
  id: string; kind: string; title: string; subtitle: string | null;
  color: string | null; visibility: string; data: unknown; item_count: number;
};

function db(bearer: string) {
  const url = Deno.env.get('SUPABASE_URL')?.trim();
  const anon = Deno.env.get('SUPABASE_ANON_KEY')?.trim();
  const headers = {
    apikey: anon ?? '',
    Authorization: `Bearer ${bearer}`,
    'Content-Type': 'application/json',
  };
  return {
    async get(path: string) {
      const r = await fetch(`${url}/rest/v1/${path}`, { headers });
      if (!r.ok) throw new Error(`קריאה מהמסד נכשלה: ${r.status} ${await r.text()}`);
      return r.json();
    },
    async patch(path: string, body: unknown) {
      const r = await fetch(`${url}/rest/v1/${path}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`עדכון נכשל: ${r.status} ${await r.text()}`);
      return r.json();
    },
    async post(path: string, body: unknown) {
      const r = await fetch(`${url}/rest/v1/${path}`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`יצירה נכשלה: ${r.status} ${await r.text()}`);
      return r.json();
    },
  };
}

/* המקטע שבתוכו יושבים הפריטים, לפי סוג הנושא */
function sectionOf(deck: Deck, wanted: string): { list: Record<string, unknown>[]; put: (v: unknown[]) => unknown } {
  if (deck.kind === 'iso') {
    const d = (deck.data ?? {}) as Record<string, unknown[]>;
    const key = ['iso', 'isoTerms', 'isoPairs'].includes(wanted) ? wanted : 'iso';
    return {
      list: (d[key] ?? []) as Record<string, unknown>[],
      put: (v) => ({ ...d, [key]: v }),
    };
  }
  return {
    list: (Array.isArray(deck.data) ? deck.data : []) as Record<string, unknown>[],
    put: (v) => v,
  };
}

/* איזה ולידטור מתאים למקטע */
function validatorKey(deck: Deck, section: string): DeckKey {
  if (deck.kind === 'iso') {
    if (section === 'isoTerms') return 'isoTerms';
    if (section === 'isoPairs') return 'isoPairs';
    return 'iso';
  }
  if (deck.kind === 'groups') return 'groups';
  if (deck.kind === 'elements') return 'elements';
  return 'topics';
}

function countItems(deck: Deck): number {
  if (deck.kind === 'iso') {
    const d = (deck.data ?? {}) as Record<string, unknown[]>;
    return (d.iso?.length ?? 0) + (d.isoTerms?.length ?? 0);
  }
  return Array.isArray(deck.data) ? deck.data.length : 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST בלבד' }, 405);

  const e = (k: string) => Deno.env.get(k)?.trim();
  const env = {
    key:   e('ANTHROPIC_API_KEY'),
    pass:  e('APP_PASSPHRASE') ?? '',
    model: e('MODEL') ?? 'claude-opus-5',
  };
  if (!env.key) return json({ error: 'חסר ANTHROPIC_API_KEY' }, 500);

  type Attachment = { media_type: string; data: string; name?: string };
  type Turn = { role: 'user' | 'assistant'; text?: string; files?: Attachment[] };
  let body: {
    passphrase?: string; check?: boolean;
    messages?: Turn[];
    /* תאימות לאחור לגרסה החד־פעמית */
    request?: string; images?: Attachment[];
  };
  try { body = await req.json(); } catch { return json({ error: 'גוף הבקשה אינו JSON' }, 400); }

  const auth = await authorize(req, body, env.pass);
  if (!auth.ok) return json({ error: auth.msg }, 401);

  if (body.check) return json({ ok: true, editor: auth.editor, model: env.model });
  if (!auth.editor) return json({ error: auth.msg }, 403);

  const bearer = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return json({ error: 'כתיבה למסד דורשת התחברות, לא סיסמה.' }, 403);

  /* שיחה. הגרסה הישנה שלחה request+images — ממירים אותה לתור אחד. */
  const turns: Turn[] = Array.isArray(body.messages) && body.messages.length
    ? body.messages.slice(-MAX_TURNS)
    : [{ role: 'user', text: body.request ?? '', files: body.images ?? [] }];

  let bytes = 0, fileCount = 0, hasText = false;
  for (const t of turns) {
    if (t.role !== 'user' && t.role !== 'assistant')
      return json({ error: 'תפקיד לא חוקי בשיחה' }, 400);
    if (typeof t.text === 'string' && t.text.trim()) hasText = true;
    if ((t.text ?? '').length > 4000) return json({ error: 'הודעה ארוכה מדי' }, 400);
    for (const f of (t.files ?? [])) {
      fileCount++;
      const ok = IMAGE_TYPES.includes(f?.media_type) || DOC_TYPES.includes(f?.media_type);
      if (!ok) return json({ error: `סוג קובץ לא נתמך: ${f?.media_type}` }, 400);
      if (typeof f?.data !== 'string' || !f.data) return json({ error: 'קובץ ריק' }, 400);
      bytes += f.data.length;
    }
  }
  if (!hasText && !fileCount) return json({ error: 'ההודעה ריקה' }, 400);
  if (fileCount > MAX_FILES) return json({ error: `עד ${MAX_FILES} קבצים` }, 400);
  if (bytes > MAX_TOTAL_B64)
    return json({ error: 'הקבצים כבדים מדי. פצל את המסמך או צרף פחות.' }, 400);

  const shots = turns.flatMap((t) => t.files ?? []);

  try {
    const rest = db(bearer);

    /* הנושאים שהמשתמש רשאי לערוך — RLS כבר סינן */
    const me = await rest.get('decks?select=id,kind,title,subtitle,color,visibility,item_count'
      + '&order=created_at.asc') as Deck[];

    const catalogue = me.map((d) => ({
      id: d.id, kind: d.kind, title: d.title, items: d.item_count,
    }));

    /* מסמכים ותמונות לפני הטקסט — כך ממליץ התיעוד, והמודל מתייחס
       אליהם כהקשר להודעה. PDF נשלח כבלוק document ב-base64. */
    function blocksFor(t: Turn): Anthropic.ContentBlockParam[] {
      const out: Anthropic.ContentBlockParam[] = [];
      for (const f of (t.files ?? [])) {
        if (DOC_TYPES.includes(f.media_type)) {
          out.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: f.data },
          } as Anthropic.ContentBlockParam);
        } else {
          out.push({
            type: 'image',
            source: { type: 'base64', media_type: f.media_type as 'image/jpeg', data: f.data },
          });
        }
      }
      const text = (t.text ?? '').trim();
      if (text) out.push({ type: 'text', text });
      else if (!out.length) out.push({ type: 'text', text: '(ריק)' });
      return out;
    }

    const convo: Anthropic.MessageParam[] = turns.map((t) => ({
      role: t.role,
      content: blocksFor(t),
    }));
    /* רשימת הנושאים נצמדת להודעה האחרונה, כדי לא לשבור את המטמון
       של תחילת השיחה */
    const last = convo[convo.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      (last.content as Anthropic.ContentBlockParam[]).push({
        type: 'text',
        text: `\n\n[הנושאים הקיימים שלי: ${JSON.stringify(catalogue)}]`,
      });
    }

    const t0 = Date.now();
    const stream = new Anthropic({ apiKey: env.key }).messages.stream({
      model: env.model,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: shots.length ? 'high' : 'medium' },
      system: SYSTEM,
      tools: [TOOL],
      messages: convo,
    });
    const message = await stream.finalMessage();
    const llmSecs = Math.round((Date.now() - t0) / 1000);

    const reply = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as unknown as { text: string }).text)
      .join('\n').trim();

    const call = message.content.find((b) => b.type === 'tool_use');
    /* אין קריאה לכלי — זו תשובה בשיחה, לא כישלון */
    if (!call) {
      return json({ ok: true, applied: null, seconds: llmSecs,
                    reply: reply || 'לא הבנתי. תוכל לנסח אחרת?' });
    }
    const patch = call.input as {
      target: string; deck_id: string; new_title: string; new_subtitle: string;
      section: string; mode: string; items_json: string; summary: string;
    };

    let items: Record<string, unknown>[];
    try {
      items = JSON.parse(patch.items_json);
      if (!Array.isArray(items)) throw new Error('לא מערך');
    } catch (err) {
      return json({ error: 'ה-JSON שהוחזר אינו תקין: ' + (err as Error).message }, 422);
    }
    if (!items.length) return json({ ok: true, applied: null, seconds: llmSecs,
      reply: reply || patch.summary || 'לא נוצר פריט.' });

    /* ---------- נושא חדש ---------- */
    if (patch.target === 'new_topic') {
      const errs: string[] = [];
      items.forEach((it, i) => validateItem('topics', it, i, errs));
      if (items.length < 4) errs.push('נושא חדש דורש ארבעה פריטים לפחות');
      const ids = new Set<string>();
      items.forEach((it) => {
        if (ids.has(it.id as string)) errs.push(`המזהה ${it.id} מופיע פעמיים`);
        ids.add(it.id as string);
      });
      if (errs.length) return json({ ok: true, applied: null, seconds: llmSecs,
        reply: (reply ? reply + '\n\n' : '') + 'לא הצלחתי לבנות פריט תקין: ' +
               errs.slice(0, 4).join(' · ') });

      /* תמיד מזהה המשתמש עצמו. שאילתה על שורה קיימת הייתה עלולה
         להחזיר בעלים של נושא ציבורי של מישהו אחר. */
      const created = await rest.post('decks', [{
        owner_id:   await currentUid(bearer),
        kind:       'topic',
        title:      patch.new_title || 'נושא חדש',
        subtitle:   patch.new_subtitle || null,
        color:      null,
        visibility: 'private',
        data:       items,
        item_count: items.length,
      }]) as Deck[];
      return json({
        ok: true, reply: reply, seconds: llmSecs,
        applied: { summary: patch.summary, deck: created[0]?.title,
                   deck_id: created[0]?.id, added: items.length, created: true },
      });
    }

    /* ---------- נושא קיים ---------- */
    const target = me.find((d) => d.id === patch.deck_id);
    if (!target) return json({ error: 'הנושא לא נמצא או שאינו שלך.' }, 422);

    const full = (await rest.get(`decks?select=*&id=eq.${target.id}`) as Deck[])[0];
    if (!full) return json({ error: 'לא הצלחתי לקרוא את הנושא.' }, 422);

    const sec = sectionOf(full, patch.section);
    const vkey = validatorKey(full, patch.section);

    const errs: string[] = [];
    items.forEach((it, i) => validateItem(vkey, it, i, errs));
    const existingIds = sec.list.map((x) => x.id as string);
    for (const it of items) {
      const dup = existingIds.includes(it.id as string);
      if (patch.mode === 'add' && dup) errs.push(`המזהה ${it.id} כבר קיים בנושא`);
      if (patch.mode === 'replace' && !dup) errs.push(`המזהה ${it.id} לא קיים, אין מה להחליף`);
    }
    if (errs.length) return json({ ok: true, applied: null, seconds: llmSecs,
      reply: (reply ? reply + '\n\n' : '') + 'הפריט לא עבר אימות: ' +
             errs.slice(0, 4).join(' · ') });

    const list = sec.list.slice();
    for (const it of items) {
      const idx = list.findIndex((x) => x.id === it.id);
      if (idx >= 0) list[idx] = it; else list.push(it);
    }
    const nextData = sec.put(list);
    const nextDeck = { ...full, data: nextData };

    await rest.patch(`decks?id=eq.${full.id}`, {
      data: nextData,
      item_count: countItems(nextDeck as Deck),
    });

    return json({
      ok: true, reply: reply, seconds: llmSecs,
      applied: {
        summary: patch.summary, deck: full.title, deck_id: full.id,
        section: patch.section, mode: patch.mode,
        added: items.length, ids: items.map((i) => i.id),
      },
    });
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message.slice(0, 400) }, 500);
  }
});

/* מזהה המשתמש מהטוקן — נדרש רק כשאין עדיין אף נושא בבעלותו */
async function currentUid(bearer: string): Promise<string> {
  const url = Deno.env.get('SUPABASE_URL')?.trim();
  const anon = Deno.env.get('SUPABASE_ANON_KEY')?.trim();
  const r = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anon ?? '', Authorization: `Bearer ${bearer}` },
  });
  if (!r.ok) throw new Error('לא הצלחתי לזהות את המשתמש');
  return (await r.json()).id as string;
}
