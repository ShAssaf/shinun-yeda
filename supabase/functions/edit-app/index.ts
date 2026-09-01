/**
 * edit-app — עריכת קוד האפליקציה עצמה. מקבל בקשה בשפה חופשית, מבקש מ-Claude
 * עריכות חיפוש־והחלפה מדויקות, מחיל אותן ודוחף ל-main.
 *
 * הבטיחות אינה כאן אלא ב-CI: tools/smoke.mjs רץ לפני הדיפלוי, וכשהוא נכשל
 * GitHub Pages ממשיך להגיש את הגרסה האחרונה שעברה. commit שבור לא מגיע לטלפון.
 * action:"rollback" מחזיר את הקבצים למצבם בקומיט הקודם.
 *
 * משתני סביבה: ANTHROPIC_API_KEY · GITHUB_TOKEN · GITHUB_REPO · APP_PASSPHRASE · MODEL
 */
import Anthropic from 'npm:@anthropic-ai/sdk@0.71.0';
import { decodeBase64, encodeBase64 } from 'jsr:@std/encoding@1/base64';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* רק אלה. הקוד לא יכול לגעת בוורקפלואו, בפונקציות או בכלי הבנייה — */
/* אחרת עריכה אחת יכולה לנטרל את שער הבדיקה עצמו.                    */
const EDITABLE = ['src/app.html', 'data/decks.json'] as const;
const MAX_BYTES = 500_000;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });

function safeEqual(a: string, b: string) {
  const ab = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function gh(path: string, token: string, init?: RequestInit) {
  const res = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'shinun-edit-app',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    if (res.status === 401) throw new Error('GITHUB_TOKEN אינו תקף.');
    if (res.status === 403 || res.status === 404)
      throw new Error('ל-GITHUB_TOKEN אין הרשאת Contents: Read and write, או ש-GITHUB_REPO שגוי.');
    throw new Error(`GitHub ${init?.method ?? 'GET'} ${path}: ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

async function readFile(repo: string, token: string, path: string) {
  const f = await gh(`/repos/${repo}/contents/${path}`, token) as
    { content: string; sha: string; encoding: string; download_url: string };
  const text = f.encoding === 'base64' && f.content
    ? new TextDecoder().decode(decodeBase64(f.content.replace(/\s+/g, '')))
    : await (await fetch(f.download_url)).text();
  return { text, sha: f.sha };
}

async function writeFile(repo: string, token: string, path: string,
                         text: string, sha: string, message: string) {
  await gh(`/repos/${repo}/contents/${path}`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: encodeBase64(new TextEncoder().encode(text)),
      sha,
      branch: 'main',
    }),
  });
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

const SYSTEM = `אתה עורך את קוד המקור של אפליקציית שינון לביוכימיה.

הקובץ src/app.html הוא האפליקציה כולה: CSS, מנוע ציור מולקולות ב-SVG, מנוע חידון, ותצוגה.
התוכן עצמו אינו שם — הוא מוזרק בזמן בנייה מ-data/decks.json אל <!--DECK_DATA-->.

מה שחשוב לדעת על הקוד:
- אין שלב טרנספילציה. JavaScript רגיל שרץ בדפדפן כמו שהוא.
- הסגנון: function ולא arrow ברוב המקומות, שרשור מחרוזות ולא תבניות, var/const לפי ההקשר הקיים.
- הממשק בעברית ו-RTL. מספרים בשורה אחת עם טקסט עברי דורשים dir="ltr".
- הצבעים הם משתני CSS מוגדרים ב-:root ומוגדרים מחדש לערכת נושא כהה. אל תכתוב צבע ליטרלי.
- כל חבילה ב-DECKS מספקת build(mode) שמחזיר שאלות בצורה
  {key, label, prompt, optionKind, options, answer, why} עם בדיוק 4 אפשרויות שאחת מהן היא answer.

אתה מחזיר עריכות חיפוש־והחלפה מדויקות בכלי propose_code_edit.
כל old חייב להופיע בקובץ פעם אחת בדיוק — כלול מספיק הקשר סביבו כדי שיהיה ייחודי.
אל תחזיר את הקובץ כולו. עריכות מינימליות וממוקדות.
שמור על הסגנון הקיים. אל תוסיף תלויות חיצוניות.`;

const TOOL: Anthropic.Tool = {
  name: 'propose_code_edit',
  description: 'עריכות חיפוש־והחלפה מדויקות בקובץ אחד.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      file: { type: 'string', enum: [...EDITABLE], description: 'איזה קובץ לערוך' },
      edits_json: {
        type: 'string',
        description: 'מערך JSON כמחרוזת: [{"old":"טקסט קיים ייחודי","new":"טקסט חדש"}]',
      },
      summary: { type: 'string', description: 'משפט אחד בעברית — מה השתנה' },
    },
    required: ['file', 'edits_json', 'summary'],
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST בלבד' }, 405);

  const e = (k: string) => Deno.env.get(k)?.trim();
  const env = {
    key: e('ANTHROPIC_API_KEY'), token: e('GITHUB_TOKEN'),
    repo: e('GITHUB_REPO'), pass: e('APP_PASSPHRASE'),
    model: e('MODEL') ?? 'claude-opus-5',
  };
  for (const [k, v] of Object.entries(env)) if (!v) return json({ error: `חסר משתנה סביבה: ${k}` }, 500);

  let body: { passphrase?: string; request?: string; action?: string };
  try { body = await req.json(); } catch { return json({ error: 'גוף הבקשה אינו JSON' }, 400); }
  const auth = await authorize(req, body, env.pass!);
  if (!auth.ok) return json({ error: auth.msg }, 401);
  if (!auth.editor) return json({ error: auth.msg }, 403);

  try {
    /* ---------- ביטול השינוי האחרון ---------- */
    if (body.action === 'rollback') {
      const commits = await gh(`/repos/${env.repo}/commits?sha=main&per_page=2`, env.token!) as
        { sha: string; commit: { message: string } }[];
      if (commits.length < 2) return json({ error: 'אין קומיט קודם לחזור אליו' }, 422);

      const head = await gh(`/repos/${env.repo}/commits/${commits[0].sha}`, env.token!) as
        { files: { filename: string; status: string }[] };
      const touched = head.files.filter((f) => (EDITABLE as readonly string[]).includes(f.filename));
      if (!touched.length)
        return json({ error: 'הקומיט האחרון לא נגע בקבצים שניתן להחזיר' }, 422);

      const restored: string[] = [];
      for (const f of touched) {
        const prev = await readFile(env.repo!, env.token!, `${f.filename}?ref=${commits[1].sha}`);
        const now = await readFile(env.repo!, env.token!, f.filename);
        await writeFile(env.repo!, env.token!, f.filename, prev.text, now.sha,
          `ביטול: ${commits[0].commit.message.split('\n')[0]}`.slice(0, 90));
        restored.push(f.filename);
      }
      return json({ ok: true, summary: 'הוחזר המצב שלפני השינוי האחרון', files: restored });
    }

    /* ---------- עריכה ---------- */
    const ask = (body.request ?? '').trim();
    if (!ask) return json({ error: 'הבקשה ריקה' }, 400);
    if (ask.length > 4000) return json({ error: 'הבקשה ארוכה מדי' }, 400);

    const app = await readFile(env.repo!, env.token!, 'src/app.html');

    const anthropic = new Anthropic({ apiKey: env.key });
    /* סטרימינג — ה-SDK מסרב לקריאה לא-סטרימית עם max_tokens גבוה,
       כי היא עלולה לחצות את תקרת עשר הדקות של בקשת HTTP אחת. */
    const stream = anthropic.messages.stream({
      model: env.model!,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: SYSTEM,
      tools: [TOOL],
      messages: [{
        role: 'user',
        content: `להלן src/app.html במלואו:\n\n<file>\n${app.text}\n</file>\n\n`
          + `בקשת השינוי:\n${ask}\n\nקרא לכלי propose_code_edit.`,
      }],
    });
    const t0 = Date.now();
    const message = await stream.finalMessage();
    console.log(`Claude החזיר אחרי ${Math.round((Date.now() - t0) / 1000)}s`);

    const call = message.content.find((b) => b.type === 'tool_use');
    if (!call) {
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      return json({ error: text.slice(0, 400) || 'Claude לא החזיר עריכה' }, 422);
    }
    const patch = call.input as { file: string; edits_json: string; summary: string };
    if (!(EDITABLE as readonly string[]).includes(patch.file))
      return json({ error: `אי אפשר לערוך את ${patch.file}` }, 422);

    let edits: { old: string; new: string }[];
    try {
      edits = JSON.parse(patch.edits_json);
      if (!Array.isArray(edits) || !edits.length) throw new Error('מערך ריק');
    } catch (err) {
      return json({ error: 'ה-JSON של העריכות אינו תקין: ' + (err as Error).message }, 422);
    }

    const target = patch.file === 'src/app.html'
      ? app
      : await readFile(env.repo!, env.token!, patch.file);

    /* החלה — כל old חייב להופיע פעם אחת בדיוק, אחרת שום דבר לא מוחל */
    let text = target.text;
    for (const [i, ed] of edits.entries()) {
      if (typeof ed?.old !== 'string' || typeof ed?.new !== 'string')
        return json({ error: `עריכה ${i + 1}: חסר old או new` }, 422);
      const n = text.split(ed.old).length - 1;
      if (n === 0) return json({ error: `עריכה ${i + 1}: הטקסט לחיפוש לא נמצא בקובץ` }, 422);
      if (n > 1) return json({ error: `עריכה ${i + 1}: הטקסט מופיע ${n} פעמים, לא ייחודי` }, 422);
      text = text.replace(ed.old, ed.new);
    }
    if (text === target.text) return json({ error: 'העריכות לא שינו דבר' }, 422);
    if (text.length > MAX_BYTES) return json({ error: 'הקובץ גדל מעבר למותר' }, 422);
    if (patch.file === 'data/decks.json') {
      try { JSON.parse(text); } catch { return json({ error: 'התוצאה אינה JSON תקין' }, 422); }
    }

    await writeFile(env.repo!, env.token!, patch.file, text, target.sha,
      `${patch.summary}`.slice(0, 90) + '\n\nבקשת המשתמש: ' + ask.slice(0, 400));

    return json({
      ok: true,
      summary: patch.summary,
      file: patch.file,
      edits: edits.length,
      note: 'בדיקת העשן רצה עכשיו. אם היא תיכשל, הגרסה החיה נשארת כמו שהיא.',
    });
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message.slice(0, 400) }, 500);
  }
});
