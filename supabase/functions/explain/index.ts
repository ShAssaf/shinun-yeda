/**
 * explain — הסבר קצר לתשובה. לא כותב לשום מקום, לא נוגע בריפו.
 * הלקוח שומר את התוצאה במטמון מקומי, כך שכל כרטיס עולה קריאה אחת בלבד.
 *
 * משתני סביבה: ANTHROPIC_API_KEY · APP_PASSPHRASE · ALLOWED_EMAILS · MODEL
 */
import Anthropic from 'npm:@anthropic-ai/sdk@0.71.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

async function authorize(req: Request, body: { passphrase?: string }, pass: string) {
  const bearer = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) {
    const url = Deno.env.get('SUPABASE_URL')?.trim();
    const anon = Deno.env.get('SUPABASE_ANON_KEY')?.trim();
    if (!url || !anon) return { ok: false, msg: 'הגדרות Supabase חסרות בפונקציה' };
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${bearer}` },
    });
    if (!r.ok) return { ok: false, msg: 'ההתחברות פגה. התחבר שוב.' };
    const user = await r.json() as { email?: string };
    const allowed = (Deno.env.get('ALLOWED_EMAILS') ?? '')
      .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!allowed.length) return { ok: false, msg: 'ALLOWED_EMAILS לא מוגדר.' };
    if (!allowed.includes((user.email ?? '').toLowerCase()))
      return { ok: false, msg: 'החשבון אינו מורשה.' };
    return { ok: true };
  }
  if (body.passphrase && safeEqual(body.passphrase, pass)) return { ok: true };
  return { ok: false, msg: 'נדרשת התחברות' };
}

const SYSTEM = `אתה מסביר לסטודנט לרפואה שטעה בשאלת שינון בביוכימיה.

שתיים עד שלוש שורות בעברית, לא יותר. בלי פתיחים ובלי "כמובן".
תן את הסיבה שמאחורי התשובה — מה מבדיל אותה מהאפשרות שנבחרה, או איזה
עיקרון גורם לה להיות נכונה. עובדה שאפשר להיאחז בה, לא חזרה על התשובה.
מונחים מקצועיים נשארים באנגלית. אם השאלה עצמה שגויה עובדתית, אמור זאת.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST בלבד' }, 405);

  const e = (k: string) => Deno.env.get(k)?.trim();
  const key = e('ANTHROPIC_API_KEY'), pass = e('APP_PASSPHRASE') ?? '';
  if (!key) return json({ error: 'חסר ANTHROPIC_API_KEY' }, 500);

  let body: { passphrase?: string; question?: string; answer?: string; chosen?: string; deck?: string };
  try { body = await req.json(); } catch { return json({ error: 'גוף הבקשה אינו JSON' }, 400); }

  const auth = await authorize(req, body, pass);
  if (!auth.ok) return json({ error: auth.msg }, 401);

  const question = (body.question ?? '').slice(0, 600);
  const answer = (body.answer ?? '').slice(0, 600);
  if (!question || !answer) return json({ error: 'חסרים שאלה או תשובה' }, 400);

  try {
    const stream = new Anthropic({ apiKey: key }).messages.stream({
      model: e('MODEL') ?? 'claude-opus-5',
      max_tokens: 700,
      output_config: { effort: 'low' },   /* הסבר קצר — עומק לא משפר אותו */
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `חבילה: ${body.deck ?? '—'}\nהשאלה: ${question}\n`
          + `התשובה הנכונה: ${answer}\n`
          + (body.chosen ? `מה שנבחר בטעות: ${String(body.chosen).slice(0, 300)}\n` : '')
          + `\nהסבר בשתיים־שלוש שורות.`,
      }],
    });
    const message = await stream.finalMessage();
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) return json({ error: 'לא התקבל הסבר' }, 422);
    return json({ ok: true, text });
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message.slice(0, 300) }, 500);
  }
});
