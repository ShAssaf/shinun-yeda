/**
 * add-question — מקבל בקשה בשפה חופשית, מבקש מ-Claude פריט תוכן תקין,
 * מאמת אותו מול הסכימה, ומבצע commit ל-data/decks.json ברפו.
 * ה-Action של GitHub בונה ומדפלוי את האתר מחדש.
 *
 * משתני סביבה נדרשים (supabase secrets set):
 *   ANTHROPIC_API_KEY   מפתח ה-API
 *   GITHUB_TOKEN        fine-grained PAT עם contents:write על הרפו הזה בלבד
 *   GITHUB_REPO         "owner/repo"
 *   APP_PASSPHRASE      סיסמה שהאפליקציה שולחת
 *   MODEL               אופציונלי, ברירת מחדל claude-opus-5
 */
import Anthropic from 'npm:@anthropic-ai/sdk@0.71.0';
import { decodeBase64, encodeBase64 } from 'jsr:@std/encoding@1/base64';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DECK_KEYS = ['groups', 'elements', 'iso', 'isoTerms', 'isoPairs', 'topics', 'ui'] as const;
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
  }
}

const MAX_CARDS = 200;

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

/* ---------- הנחיה ל-Claude ---------- */

const SYSTEM = `אתה עורך התוכן של אפליקציית שינון לביוכימיה, בעברית.
המשתמש מבקש להוסיף פריט או לתקן פריט קיים. אתה מחזיר את הפריטים בכלי propose_patch בלבד.

מבנה הנתונים לפי חבילה:

groups — קבוצה פונקציונלית:
  id (slug), en (שם אנגלי), he (שם עברי), cat (hc|ox|n|s|p),
  a — אטומים: [{"t":"C","x":1,"y":0}]  t היא התווית המוצגת (C, O, N, S, P, H, R, R¹, O⁻, N⁺, OH, CH₃ ...)
  b — קשרים: [[i,j,order]] אינדקסים למערך a. order: 1 יחיד, 2 כפול, 3 טריז, 4 מקווקו.

elements — יסוד:
  id (זהה ל-sym), sym (סמל), en, he, cat (bulk|trace), role (תפקיד ביוכימי, משפט אחד בעברית)

iso — צומת בעץ האיזומרים:
  id, he, en, parent (id של צומת קיים), depth (מספר), color (מחרוזת CSS כמו "var(--c-o)"), def, ex

isoTerms — מושג נלווה: id, he, en, def, ex

ui — תוויות הממשק (טקסט בלבד, לא תוכן לימודי). מבנה הפריטים שונה:
  [{"path":"cats.s","value":"גופרית"}] — path הוא נתיב נקודות לתווית קיימת, value המחרוזת החדשה.
  נתיבים זמינים: cats.<hc|ox|n|s|p> · rel.<chain|position|functional|geometric|enantiomers|diastereomers|conformers|same>
  decks.<fg|el|iso>.title · .sub · .modes.<id>.title · .modes.<id>.desc · .legend.<key>
  ב-ui תמיד mode="replace". אי אפשר להוסיף נתיב חדש, רק לשנות ערך של נתיב קיים.

topics — חבילת נושא חופשית. **זה היעד לכל נושא שאינו קבוצה פונקציונלית, יסוד או איזומריה**:
  ביולוגיה של התא, מסלולים מטבוליים, אנזימולוגיה, פרמקולוגיה, ויטמינים — הכול.
  אל תסרב לבקשה בטענה שאין חבילה מתאימה. אם אין — צור חבילת נושא חדשה.
  פריט: {"id":"microtubules","title":"מיקרוטובולים","sub":"שלד התא",
          "cards":[{"id":"tubulin","front":"טובולין","frontSub":"Tubulin",
                    "back":"דימר α/β שממנו נבנה המיקרוטובול","note":"הערה אופציונלית"}]}
  front הוא המושג, back הוא ההסבר. נדרשים לפחות 4 כרטיסים כדי שהחבילה תופיע.
  mode="add" ליצירת חבילה חדשה, mode="replace" להוספת כרטיסים או תיקון בחבילה קיימת
  (הכרטיסים ממוזגים לפי id — קיים מוחלף, חדש נוסף).

isoPairs — זוג מבנים לזיהוי היחס:
  id, rel (chain|position|functional|geometric|enantiomers|diastereomers|conformers|same),
  label, A ו-B (כל אחד {"a":[...],"b":[...]} כמו ב-groups), why (הסבר קצר בעברית)

כללי ציור מולקולות:
- הרשת ביחידות של 1. קשר טיפוסי באורך 1 עד 1.5. תוויות ארוכות (CH₂OH) דורשות מרווח 1.5.
- x גדל ימינה, y גדל למטה.
- אל תמציא גיאומטריה מסובכת. שרשרת אופקית פשוטה עדיפה על טבעת שגויה.
- לטריז ומקווקו יש משמעות סטראוכימית — השתמש בהם רק כשהיא רלוונטית.

כללים:
- id ייחודי, באותיות אנגליות קטנות ומקפים. אל תתנגש ב-id קיים אלא אם אתה מתקן פריט קיים (אז mode="replace" ואותו id).
- טקסט למשתמש בעברית. שמות אנגליים נשארים באנגלית.
- דיוק מדעי קודם לכל. אם הבקשה שגויה עובדתית, תקן אותה וציין זאת ב-summary.
- אם הבקשה לא ברורה או לא שייכת לאף חבילה, החזר items ריק והסבר ב-summary.`;

const TOOL: Anthropic.Tool = {
  name: 'propose_patch',
  description: 'מחזיר את הפריטים להוספה או להחלפה בקובץ התוכן.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      deck: { type: 'string', enum: [...DECK_KEYS], description: 'לאיזו חבילה' },
      mode: { type: 'string', enum: ['add', 'replace'], description: 'add להוספה, replace לתיקון פריט קיים לפי id' },
      items_json: {
        type: 'string',
        description: 'מערך JSON של הפריטים, כמחרוזת. חייב להיות JSON תקין.',
      },
      summary: { type: 'string', description: 'משפט אחד בעברית — מה נעשה' },
    },
    required: ['deck', 'mode', 'items_json', 'summary'],
  },
};

/* ---------- GitHub ---------- */

async function gh(path: string, token: string, init?: RequestInit) {
  const res = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'shinun-add-question',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    if (res.status === 401)
      throw new Error('GITHUB_TOKEN אינו תקף. צור טוקן חדש והגדר אותו מחדש ב-supabase secrets.');
    if (res.status === 403 || res.status === 404)
      throw new Error(`ל-GITHUB_TOKEN אין הרשאת Contents: Read and write על ${Deno.env.get('GITHUB_REPO')?.trim()}, `
        + 'או ש-GITHUB_REPO שגוי.');
    throw new Error(`GitHub ${init?.method ?? 'GET'} ${path}: ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

/* ---------- handler ---------- */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST בלבד' }, 405);

  /* trim — ערך שהודבק עם רווח או שורה חדשה נגררת שובר את האימות מול GitHub */
  const envRaw = (k: string) => Deno.env.get(k)?.trim();
  const env = {
    key: envRaw('ANTHROPIC_API_KEY'),
    token: envRaw('GITHUB_TOKEN'),
    repo: envRaw('GITHUB_REPO'),
    pass: envRaw('APP_PASSPHRASE'),
    model: envRaw('MODEL') ?? 'claude-opus-5',
  };
  for (const [k, v] of Object.entries(env)) {
    if (!v) return json({ error: `חסר משתנה סביבה: ${k}` }, 500);
  }

  let body: { passphrase?: string; request?: string; deck?: string; check?: boolean };
  try { body = await req.json(); } catch { return json({ error: 'גוף הבקשה אינו JSON' }, 400); }

  if (!body.passphrase || !safeEqual(body.passphrase, env.pass!))
    return json({ error: 'סיסמה שגויה' }, 401);

  /* בדיקת תקינות — מאמתת את שני המפתחות בלי לכתוב כלום ובלי לצרוך טוקנים */
  if (body.check) {
    const out: Record<string, string> = { repo: env.repo! };
    try {
      await gh(`/repos/${env.repo}/contents/data/decks.json`, env.token!);
      out.github = 'תקין — קריאה עובדת';
    } catch (e) { out.github = 'שגיאה: ' + (e as Error).message; }
    try {
      await new Anthropic({ apiKey: env.key }).models.list({ limit: 1 });
      out.anthropic = 'תקין — המפתח מאומת';
    } catch (e) { out.anthropic = 'שגיאה: ' + (e as Error).message.slice(0, 160); }
    out.model = env.model!;
    return json(out, 200);
  }

  const ask = (body.request ?? '').trim();
  if (!ask) return json({ error: 'הבקשה ריקה' }, 400);
  if (ask.length > 2000) return json({ error: 'הבקשה ארוכה מדי' }, 400);

  try {
    /* התוכן הנוכחי — גם כהקשר ל-Claude וגם לצורך ה-sha של ה-commit */
    const file = await gh(`/repos/${env.repo}/contents/data/decks.json`, env.token!) as
      { content: string; sha: string; encoding: string; download_url: string };

    /* GitHub עוטף את ה-base64 בשורות חדשות, ו-decodeBase64 דוחה רווחים.
       לקבצים גדולים מ-1MB הוא מחזיר encoding "none" וצריך למשוך את הגולמי. */
    let raw: string;
    if (file.encoding === 'base64' && file.content) {
      raw = new TextDecoder().decode(decodeBase64(file.content.replace(/\s+/g, '')));
    } else {
      const r = await fetch(file.download_url);
      if (!r.ok) throw new Error('לא הצלחתי למשוך את data/decks.json');
      raw = await r.text();
    }
    const current = JSON.parse(raw);

    /* מזהים קיימים — מונע התנגשויות וכפילויות */
    const existing: Record<string, string[]> = {};
    for (const k of DECK_KEYS) {
      existing[k] = Array.isArray(current[k]) ? current[k].map((x: { id: string }) => x.id) : [];
    }

    const hint = body.deck && body.deck !== 'auto'
      ? `\nהמשתמש בחר את החבילה: ${({ fg: 'groups', el: 'elements', iso: 'iso / isoTerms / isoPairs' })[body.deck as 'fg'] ?? body.deck}`
      : '';

    const anthropic = new Anthropic({ apiKey: env.key });
    const message = await anthropic.messages.create({
      model: env.model!,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: SYSTEM,
      tools: [TOOL],
      messages: [{
        role: 'user',
        content: `מזהים קיימים בכל חבילה:\n${JSON.stringify(existing)}\n\n`
          + `דוגמאות לפריטים קיימים (לחיקוי הסגנון):\n`
          + JSON.stringify({
            groups: current.groups?.slice(0, 2),
            elements: current.elements?.slice(0, 1),
            isoPairs: current.isoPairs?.slice(0, 1),
          })
          + `\n\nבקשת המשתמש:\n${ask}${hint}\n\nקרא לכלי propose_patch.`,
      }],
    });

    const call = message.content.find((b) => b.type === 'tool_use');
    if (!call) {
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      return json({ error: text.slice(0, 300) || 'Claude לא החזיר פריט' }, 422);
    }
    const patch = call.input as { deck: DeckKey; mode: string; items_json: string; summary: string };

    let items: Record<string, unknown>[];
    try {
      items = JSON.parse(patch.items_json);
      if (!Array.isArray(items)) throw new Error('לא מערך');
    } catch (e) {
      return json({ error: 'ה-JSON שהוחזר אינו תקין: ' + (e as Error).message }, 422);
    }
    if (!items.length) return json({ error: patch.summary || 'לא נוצר פריט' }, 422);
    if (!DECK_KEYS.includes(patch.deck)) return json({ error: 'חבילה לא מוכרת' }, 422);

    const errs: string[] = [];

    if (patch.deck === 'topics') {
      items.forEach((it, i) => validateTopic(it, i, errs));
      if (typeof items[0]?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(items[0].id as string))
        errs.push('topics[0].id חייב להיות slug באנגלית קטנה');
      if (errs.length) return json({ error: 'לא עבר אימות: ' + errs.slice(0, 4).join(' · ') }, 422);

      current.topics ??= [];
      for (const t of items) {
        const found = (current.topics as Record<string, unknown>[]).find((x) => x.id === t.id);
        if (!found) { current.topics.push(t); continue; }
        /* מיזוג כרטיסים לפי id — קיים מוחלף, חדש נוסף */
        const cards = found.cards as Record<string, unknown>[];
        for (const c of t.cards as Record<string, unknown>[]) {
          const k = cards.findIndex((x) => x.id === c.id);
          if (k >= 0) cards[k] = c; else cards.push(c);
        }
        if (t.title) found.title = t.title;
        if (t.sub) found.sub = t.sub;
      }
      const short = (current.topics as { title: string; cards: unknown[] }[])
        .filter((t) => t.cards.length < 4).map((t) => t.title);
      if (short.length)
        return json({ error: `חבילה זקוקה ל-4 כרטיסים לפחות. חסרים ב: ${short.join(', ')}` }, 422);
    } else if (patch.deck === 'ui') {
      if (patch.mode !== 'replace') errs.push('בתוויות ממשק אפשר רק mode="replace"');
      items.forEach((it, i) => validateLabel(current.ui, it, i, errs));
      if (errs.length) return json({ error: 'לא עבר אימות: ' + errs.slice(0, 4).join(' · ') }, 422);
      for (const it of items) setPath(current.ui, it.path as string, it.value as string);
    } else {
      items.forEach((it, i) => validateItem(patch.deck, it, i, errs));
      const ids = existing[patch.deck];
      for (const it of items) {
        const dup = ids.includes(it.id as string);
        if (patch.mode === 'add' && dup) errs.push(`המזהה ${it.id} כבר קיים`);
        if (patch.mode === 'replace' && !dup) errs.push(`המזהה ${it.id} לא קיים, אין מה להחליף`);
      }
      if (errs.length) return json({ error: 'הפריט לא עבר אימות: ' + errs.slice(0, 4).join(' · ') }, 422);

      const list = current[patch.deck] as Record<string, unknown>[];
      for (const it of items) {
        const idx = list.findIndex((x) => x.id === it.id);
        if (idx >= 0) list[idx] = it; else list.push(it);
      }
    }

    const updated = encodeBase64(new TextEncoder().encode(JSON.stringify(current, null, 2) + '\n'));
    await gh(`/repos/${env.repo}/contents/data/decks.json`, env.token!, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `תוכן: ${patch.summary}`.slice(0, 90) + '\n\nבקשת המשתמש: ' + ask.slice(0, 400),
        content: updated,
        sha: file.sha,
        branch: 'main',
      }),
    });

    return json({
      ok: true,
      summary: patch.summary,
      deck: patch.deck,
      mode: patch.mode,
      ids: items.map((i) => i.id ?? i.path),
    });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message.slice(0, 400) }, 500);
  }
});
