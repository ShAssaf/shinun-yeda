-- סנכרון אמין בין מכשירים, אדמין קבוע, ובקרה על חבילות ציבוריות.
-- להרצה פעם אחת ב-SQL Editor של Supabase, אחרי 0005.
--
-- כל הפקודות כאן אידמפוטנטיות, כך שהרצה חוזרת בטוחה ואינה משנה נתונים:
-- הרשאת "חבילות ותיקות" (סעיף 5) רצה רק בפעם הראשונה, כשהעמודה נוצרת.
--
-- למה בכלל: עד עכשיו card_state ו-review_log דרשו user_id בלי ברירת מחדל,
-- והלקוח מעולם לא שלח אותו — כל כתיבה נכשלה בשקט והטבלאות בשרת ריקות.
-- שורת האדמין מ-0003 נוספה רק אם המשתמש כבר היה קיים כשהיא רצה.
-- ופרסום חבילה היה מיידי, בלי שאף אחד עובר עליה.
--
-- ה-SQL Editor רץ כ-postgres: שם auth.uid() הוא NULL ו-RLS לא חל.
-- הטריגרים כאן מתייחסים ל-NULL כאל "תחזוקה מהעורך" ולא חוסמים אותה.

-- ------------------------------------------------------ 1. מצב הכרטיסים
-- הלקוח לא שולח user_id; השרת ממלא אותו מהטוקן. כך גם אין דרך לכתוב
-- בשם משתמש אחר — ה-RLS ממילא דורש שהערך יהיה auth.uid().
alter table public.card_state alter column user_id set default auth.uid();

-- מכשיר ישן שמסנכרן אחרי שעות אופליין לא יחזיר אחורה מצב חדש יותר.
-- החזרת NULL בטריגר BEFORE UPDATE מדלגת על השורה — ובתוך
-- INSERT … ON CONFLICT DO UPDATE זה אומר שהשורה פשוט נשארת כמו שהיא,
-- בלי שגיאה, ושאר השורות באותה אצווה ממשיכות.
-- last_review שווה מותר: שליחה חוזרת של אותה אצווה היא לא שגיאה.
create or replace function public.card_state_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.last_review < old.last_review then
    return null;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists card_state_guard on public.card_state;
create trigger card_state_guard before update on public.card_state
  for each row execute function public.card_state_guard();

-- ------------------------------------------------------- 2. יומן חזרות
alter table public.review_log alter column user_id set default auth.uid();

-- מזהה שהלקוח מייצר לכל חזרה. אצווה שנשלחה, נכשלה באמצע ונשלחת שוב
-- לא תכפיל את היומן: הלקוח שולח
--   POST review_log?on_conflict=user_id,client_id
--   Prefer: resolution=ignore-duplicates
-- שורות ישנות נשארות עם NULL, ו-NULL אינו מתנגש עם NULL — אין בעיה.
alter table public.review_log add column if not exists client_id uuid;
create unique index if not exists review_log_client_uniq
  on public.review_log (user_id, client_id);

-- ------------------------------------------------------- 3. הגדרות משתמש
-- כמו בשאר הטבלאות: ה-user_id נלקח מהטוקן אם הלקוח לא שלח אותו.
alter table public.user_settings alter column user_id set default auth.uid();

-- הלקוח שולח ב-updated_at את הרגע שבו תאריך המבחן שונה אצלו.
-- מכשיר אופליין עם תאריך ישן יותר לא דורס תאריך חדש שנקבע במכשיר אחר.
-- מונה הסבבים רק עולה: מכשיר שפספס סבבים לא מאפס את מה שנספר.
create or replace function public.user_settings_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.updated_at < old.updated_at then
    new.exam_date  := old.exam_date;
    new.updated_at := old.updated_at;
  end if;
  new.rounds := greatest(coalesce(new.rounds, 0), coalesce(old.rounds, 0));
  return new;
end $$;

drop trigger if exists user_settings_guard on public.user_settings;
create trigger user_settings_guard before update on public.user_settings
  for each row execute function public.user_settings_guard();

-- ------------------------------------------------------ 4. אדמין קבוע
-- ב-0003 שורת האדמין נוספה רק אם המשתמש כבר היה רשום באותו רגע.
-- מעכשיו ההרשאה נשמרת לפי מייל, והטריגר על auth.users מעניק אותה
-- ברגע שהמייל מאומת — גם למי שנרשם אחרי שהמיגרציה רצה.
-- אין מדיניות RLS בכלל: רק ה-SQL Editor קורא וכותב את הטבלה הזו.
create table if not exists public.admin_emails (
  email text primary key check (email = lower(email))
);

alter table public.admin_emails enable row level security;
revoke all on public.admin_emails from anon, authenticated;

insert into public.admin_emails (email) values ('shlomo.assaf7@gmail.com')
on conflict do nothing;

-- מי שכבר רשום ומאומת מקבל את ההרשאה עכשיו
insert into public.admins (user_id)
select u.id
from auth.users u
join public.admin_emails e on lower(u.email) = e.email
where u.email_confirmed_at is not null
on conflict do nothing;

-- ורק מייל מאומת: בלי זה, הרשמה בסיסמה עם המייל של האדמין הייתה מספיקה.
-- משתמשי גוגל מגיעים עם email_confirmed_at מלא כבר ביצירה.
create or replace function public.grant_admin_by_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null
     and exists (select 1 from public.admin_emails e where e.email = lower(new.email)) then
    insert into public.admins (user_id) values (new.id)
    on conflict do nothing;
  end if;
  return new;
end $$;

-- auth.users שייכת ל-supabase_auth_admin, לא ל-postgres. ליצור טריגר מותר
-- (הרשאת TRIGGER), אבל drop trigger דורש בעלות ונכשל — ולכן יוצרים רק
-- אם אינו קיים. גוף הפונקציה מתעדכן ממילא ב-create or replace שלמעלה.
-- אם גם היצירה נחסמת, המיגרציה לא נופלת: האדמין הקיים כבר קיבל הרשאה
-- בשורה שלמעלה, ורק הרשמה עתידית תדרוש את ההוספה הידנית שבהמשך.
do $$
begin
  if not exists (select 1 from pg_trigger
                 where tgrelid = 'auth.users'::regclass and tgname = 'grant_admin_by_email') then
    begin
      create trigger grant_admin_by_email
        after insert or update of email, email_confirmed_at on auth.users
        for each row execute function public.grant_admin_by_email();
    exception when insufficient_privilege then
      raise warning 'לא נוצר טריגר על auth.users (%). אדמין חדש יתווסף ידנית — ראה למטה.', sqlerrm;
    end;
  end if;
end $$;

-- הוספת אדמין נוסף (ב-SQL Editor, עם המייל באותיות קטנות):
--   insert into public.admin_emails (email) values ('someone@example.com')
--   on conflict do nothing;
-- אם הוא כבר רשום, הטריגר לא ירוץ עד שהמייל שלו ישתנה — אז גם:
--   insert into public.admins (user_id)
--   select id from auth.users
--   where lower(email) = 'someone@example.com' and email_confirmed_at is not null
--   on conflict do nothing;
-- הסרה: למחוק את השורה משתי הטבלאות.
--
-- בדיקה:
--   select e.email, u.id is not null as registered, a.user_id is not null as admin
--   from public.admin_emails e
--   left join auth.users u on lower(u.email) = e.email
--   left join public.admins a on a.user_id = u.id;
--   select tgname from pg_trigger where tgrelid = 'auth.users'::regclass;  -- grant_admin_by_email

-- -------------------------------------------------- 5. בקרה על חבילות
-- פרסום כבר אינו מיידי: חבילה שהופכת לציבורית ממתינה לאישור אדמין,
-- ועריכה של חבילה מאושרת מחזירה אותה לתור. מי שכבר נרשם לחבילה
-- ממשיך לראות אותה בזמן ההמתנה, כדי שעריכה לא תעלים לו את הכרטיסים.
--   none     — פרטית: לא נשלחה לבדיקה, או שהוסתרה לפני הכרעה
--   pending  — ציבורית, ממתינה (חדשה או שנערכה אחרי אישור)
--   approved — ציבורית ומאושרת, גלויה לכולם
--   rejected — נדחתה והוחזרה לפרטית, עם הערה לבעלים
alter table public.decks add column if not exists reviewed_by uuid references auth.users (id) on delete set null;
alter table public.decks add column if not exists reviewed_at timestamptz;
alter table public.decks add column if not exists review_note text;

-- העמודה והאישור הגורף לחבילות הוותיקות באותו צעד, ורק בפעם הראשונה:
-- חבילה שכבר ציבורית יש לה מנויים שחייבים להמשיך לראות אותה.
-- בהרצה חוזרת העמודה כבר קיימת — ואז שום חבילה ממתינה לא מאושרת בטעות.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'decks'
                   and column_name = 'review_status') then
    alter table public.decks add column review_status text not null default 'none';
    update public.decks
       set review_status = 'approved', reviewed_at = coalesce(reviewed_at, now())
     where visibility = 'public' and review_status <> 'approved';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'decks_review_status_chk'
                   and conrelid = 'public.decks'::regclass) then
    alter table public.decks add constraint decks_review_status_chk
      check (review_status in ('none','pending','approved','rejected'));
  end if;
end $$;

-- תור הבדיקה של האדמין, והקטלוג הציבורי
create index if not exists decks_review_idx
  on public.decks (review_status, updated_at desc) where visibility = 'public';

-- הטריגר הוא שקובע את review_status — לא הלקוח. משתמש רגיל שישלח
-- review_status='approved' יקבל את מה שהטריגר מחליט.
-- השם decks_moderate קודם אלפביתית ל-decks_snapshot, ולכן רץ לפניו;
-- snapshot_deck ממשיך לשמור היסטוריה בדיוק כמו קודם.
create or replace function public.decks_moderate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- SQL Editor ותחזוקה: סומכים
  if auth.uid() is null then return new; end if;

  -- אדמין: פרסום שלו מאושר מיד. דחייה מפורשת מה-RPC נשארת כפי שהיא.
  if public.is_admin() then
    if new.visibility = 'public' and new.review_status in ('none','pending') then
      new.review_status := 'approved';
      new.reviewed_by   := auth.uid();
      new.reviewed_at   := now();
      new.review_note   := null;
    elsif new.visibility <> 'public' and new.review_status in ('pending','approved') then
      new.review_status := 'none';
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- גם ביצירה updated_at אינו בידי הבעלים: אחרת מחיקה ויצירה מחדש עם אותו
    -- id ואותו updated_at שהאדמין ראה הייתה מעבירה תוכן אחר דרך p_seen.
    new.updated_at    := now();
    new.review_status := case when new.visibility = 'public' then 'pending' else 'none' end;
    new.reviewed_by   := null;
    new.reviewed_at   := null;
    new.review_note   := null;
    return new;
  end if;

  -- עדכון של משתמש רגיל: שדות הבקרה, הבעלות והזמנים אינם בידיו.
  -- updated_at זז רק כשהתוכן משתנה — זו הגרסה שהאדמין מאשר (admin_review_deck
  -- משווה אליה), ולכן אסור שהבעלים יוכל לקבע אותה.
  new.owner_id      := old.owner_id;
  new.created_at    := old.created_at;
  new.updated_at    := case when (new.data, new.title, new.subtitle, new.kind)
                                 is distinct from (old.data, old.title, old.subtitle, old.kind)
                            then now() else old.updated_at end;
  new.review_status := old.review_status;
  new.reviewed_by   := old.reviewed_by;
  new.reviewed_at   := old.reviewed_at;
  new.review_note   := old.review_note;

  if new.visibility = 'public' and old.visibility <> 'public' then
    new.review_status := 'pending';
    new.review_note   := null;
  elsif new.visibility <> 'public' and old.visibility = 'public' then
    -- דחייה לא נמחקת בהסתרה והצגה חוזרת
    new.review_status := case when old.review_status = 'rejected' then 'rejected' else 'none' end;
  elsif new.visibility = 'public'
        and (new.data     is distinct from old.data
          or new.title    is distinct from old.title
          or new.subtitle is distinct from old.subtitle
          or new.kind     is distinct from old.kind) then
    -- reviewed_at נשאר: האדמין רואה שהחבילה אושרה פעם ומאז השתנתה
    new.review_status := 'pending';
  end if;
  return new;
end $$;

drop trigger if exists decks_moderate on public.decks;
create trigger decks_moderate before insert or update on public.decks
  for each row execute function public.decks_moderate();

-- קריאה:
--   הבעלים — תמיד.
--   כולם — ציבורית ומאושרת.
--   מנוי — ציבורית גם בזמן שעריכה ממתינה לאישור.
--   אדמין — כל חבילה ציבורית, כולל ממתינות, וחבילות שהוא דחה (כדי לעיין
--           בהן ולמחוק). לא שאר החבילות הפרטיות של אחרים.
-- אין רקורסיה: subs_read בודק רק user_id ואינו נוגע ב-decks.
drop policy if exists decks_read on public.decks;
create policy decks_read on public.decks
  for select to authenticated
  using (
    owner_id = auth.uid()
    or (visibility = 'public' and review_status = 'approved')
    or (visibility = 'public' and exists (
          select 1 from public.deck_subscriptions s
          where s.deck_id = decks.id and s.user_id = auth.uid()))
    or (visibility = 'public' and (select public.is_admin()))
    or (review_status = 'rejected' and (select public.is_admin()))
  );

-- אדמין מוחק חבילה ציבורית פוגענית. מדיניות decks_delete של הבעלים נשארת.
-- אין מדיניות עדכון לאדמין: אישור ודחייה עוברים רק דרך admin_review_deck.
drop policy if exists decks_admin_delete on public.decks;
create policy decks_admin_delete on public.decks
  for delete to authenticated using ((select public.is_admin()));

-- הרשמה רק לחבילה משלך או לחבילה מאושרת
drop policy if exists subs_write on public.deck_subscriptions;
create policy subs_write on public.deck_subscriptions
  for insert to authenticated
  with check (user_id = auth.uid()
    and exists (select 1 from public.decks d
                where d.id = deck_subscriptions.deck_id
                  and (d.owner_id = auth.uid()
                       or (d.visibility = 'public' and d.review_status = 'approved'))));

-- האדמין צריך לראות מה השתנה מאז האישור — באותו גבול שבו הוא רואה את
-- החבילות עצמן: ציבוריות, ומה שהוא דחה.
drop policy if exists deck_history_read on public.deck_history;
create policy deck_history_read on public.deck_history
  for select to authenticated
  using (exists (select 1 from public.decks d
                 where d.id = deck_history.deck_id
                   and (d.owner_id = auth.uid()
                        or ((d.visibility = 'public' or d.review_status = 'rejected')
                            and (select public.is_admin())))));

-- ------------------------------------------------------- 6. פעולות אדמין
-- כולן security definer ובודקות is_admin() בשורה הראשונה. זו ההרשאה
-- היחידה; ה-GRANT ל-authenticated רק מאפשר לקרוא להן.
-- פונקציה שמחזירה טבלה נמחקת קודם: create or replace נכשל אם העמודות השתנו.

-- הכרעה על חבילה.
--   approved — נשארת ציבורית ומאושרת. רק אם התוכן הוא בדיוק מה שהאדמין
--              ראה (p_seen = updated_at של אותה גרסה): אחרת בעלים שמחליף
--              תוכן בין התצוגה לאישור היה מקבל אישור על משהו שאיש לא ראה.
--   rejected — חוזרת לפרטית, עם הערה שהבעלים רואה, והמינויים של אחרים
--              נמחקים. בלי זה פרסום חוזר היה מציג למנויים הישנים תוכן
--              שאיש לא אישר, עוד לפני שהאדמין ראה אותו.
-- החתימה השתנתה (נוסף p_seen), ולכן הגרסה הקודמת נמחקת.
drop function if exists public.admin_review_deck(uuid, text, text);
create or replace function public.admin_review_deck(p_deck uuid, p_verdict text,
                                                    p_note text default null,
                                                    p_seen timestamptz default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_visibility text;
  v_updated    timestamptz;
  v_owner      uuid;
  v_status     text;
begin
  if not public.is_admin() then raise exception 'אין הרשאה' using errcode = '42501'; end if;

  -- PT404: קוד שגיאה ש-PostgREST מתרגם ל-HTTP 404
  select d.visibility, d.updated_at, d.owner_id into v_visibility, v_updated, v_owner
    from public.decks d where d.id = p_deck for update;
  if not found then raise exception 'החבילה לא נמצאה' using errcode = 'PT404'; end if;

  if p_verdict = 'approved' then
    if v_visibility <> 'public' then raise exception 'החבילה אינה ציבורית'; end if;
    -- PT409: ‏HTTP 409 — הגרסה השתנתה
    if p_seen is null or v_updated is distinct from p_seen then
      raise exception 'הנושא השתנה מאז שנטען — פתח אותו שוב לפני האישור' using errcode = 'PT409';
    end if;
    update public.decks
       set review_status = 'approved', reviewed_by = auth.uid(),
           reviewed_at = now(), review_note = null
     where id = p_deck
    returning review_status into v_status;
  elsif p_verdict = 'rejected' then
    update public.decks
       set visibility = 'private', review_status = 'rejected',
           review_note = nullif(trim(p_note), ''),
           reviewed_by = auth.uid(), reviewed_at = now()
     where id = p_deck
    returning review_status into v_status;
    delete from public.deck_subscriptions s
     where s.deck_id = p_deck and s.user_id <> v_owner;
  else
    raise exception 'הכרעה לא מוכרת: %', coalesce(p_verdict, 'null');
  end if;

  return v_status;
end $$;

revoke all on function public.admin_review_deck(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.admin_review_deck(uuid, text, text, timestamptz) to authenticated;

-- תור הבדיקה: כל החבילות הציבוריות והנדחות, ממתינות קודם
drop function if exists public.admin_moderation();
create function public.admin_moderation()
returns table (
  id uuid, kind text, title text, subtitle text, item_count int,
  visibility text, review_status text, review_note text, reviewed_at timestamptz,
  created_at timestamptz, updated_at timestamptz,
  owner_id uuid, owner_email text, subscribers int
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_admin() then raise exception 'אין הרשאה' using errcode = '42501'; end if;

  return query
  select d.id, d.kind, d.title, d.subtitle, d.item_count,
         d.visibility, d.review_status, d.review_note, d.reviewed_at,
         d.created_at, d.updated_at,
         d.owner_id, u.email::text,
         (select count(*)::int from public.deck_subscriptions s
           where s.deck_id = d.id and s.user_id <> d.owner_id)
    from public.decks d
    left join auth.users u on u.id = d.owner_id
   where d.visibility = 'public' or d.review_status = 'rejected'
   order by (d.review_status = 'pending') desc, d.updated_at desc;
end $$;

revoke all on function public.admin_moderation() from public, anon;
grant execute on function public.admin_moderation() to authenticated;

-- יומן התקלות עם המייל של המדווח. דפדוף לפי id (p_before = ה-id
-- האחרון שהתקבל), וחיפוש חופשי על סוג, הודעה, הקשר ומייל.
drop function if exists public.admin_error_log(bigint, int, text);
create function public.admin_error_log(p_before bigint default null, p_limit int default 100, p_q text default null)
returns table (
  id bigint, at timestamptz, kind text, message text, context jsonb,
  app text, user_agent text, user_id uuid, email text
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  q text := lower(nullif(trim(p_q), ''));
begin
  if not public.is_admin() then raise exception 'אין הרשאה' using errcode = '42501'; end if;

  return query
  select e.id, e.at, e.kind, e.message, e.context,
         e.app, e.user_agent, e.user_id, u.email::text
    from public.error_log e
    left join auth.users u on u.id = e.user_id
   where (p_before is null or e.id < p_before)
     and (q is null or strpos(lower(concat_ws(' ', e.kind, e.message, e.context::text, u.email)), q) > 0)
   order by e.id desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
end $$;

revoke all on function public.admin_error_log(bigint, int, text) from public, anon;
grant execute on function public.admin_error_log(bigint, int, text) to authenticated;

-- ניקוי תקלות ישנות. מינימום יום אחד, כדי ש-0 בטעות לא ימחק הכול.
create or replace function public.admin_prune_errors(p_days int)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  if not public.is_admin() then raise exception 'אין הרשאה' using errcode = '42501'; end if;

  delete from public.error_log
   where at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.admin_prune_errors(int) from public, anon;
grant execute on function public.admin_prune_errors(int) to authenticated;

-- בריאות הסנכרון: שורה לכל משתמש רשום. מי שתרגל (reviews_7d > 0)
-- ואין לו כרטיסים בשרת (cards = 0) — אצלו הסנכרון שבור.
drop function if exists public.admin_users();
create function public.admin_users()
returns table (
  user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  is_admin boolean, decks int, cards int, last_card_at timestamptz,
  reviews_7d int, errors_7d int, settings_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_admin() then raise exception 'אין הרשאה' using errcode = '42501'; end if;

  return query
  select u.id, u.email::text, u.created_at, u.last_sign_in_at,
         exists (select 1 from public.admins a where a.user_id = u.id),
         (select count(*)::int from public.decks d where d.owner_id = u.id),
         cs.n, cs.last_at,
         (select count(*)::int from public.review_log r
           where r.user_id = u.id and r.reviewed_at > now() - interval '7 days'),
         (select count(*)::int from public.error_log e
           where e.user_id = u.id and e.at > now() - interval '7 days'),
         (select s.updated_at from public.user_settings s where s.user_id = u.id)
    from auth.users u
    left join lateral (
      select count(*)::int as n, max(c.updated_at) as last_at
        from public.card_state c where c.user_id = u.id
    ) cs on true
   order by u.last_sign_in_at desc nulls last;
end $$;

revoke all on function public.admin_users() from public, anon;
grant execute on function public.admin_users() to authenticated;

-- ------------------------------------------------------ 7. יומן התקלות
-- כל משתמש מחובר כותב ליומן, והאדמין קורא אותו ב-HTML. תקרות אורך
-- וסוגים סגורים שומרים שדיווח אחד לא ינפח את הטבלה או יכניס זבל.
-- NOT VALID: שורות קיימות לא נבדקות (ולא יכשילו את המיגרציה),
-- כל שורה חדשה כן. הלקוח שולח עכשיו גם at — רגע התקלה, לא רגע הסנכרון.
alter table public.error_log alter column user_id set default auth.uid();

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'error_log_kind_chk' and conrelid = 'public.error_log'::regclass) then
    alter table public.error_log add constraint error_log_kind_chk
      check (kind in ('client','fetch','function','promise','sync')) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'error_log_msg_chk' and conrelid = 'public.error_log'::regclass) then
    alter table public.error_log add constraint error_log_msg_chk
      check (char_length(message) <= 500) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'error_log_ctx_chk' and conrelid = 'public.error_log'::regclass) then
    alter table public.error_log add constraint error_log_ctx_chk
      check (context is null or pg_column_size(context) <= 4096) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'error_log_ua_chk' and conrelid = 'public.error_log'::regclass) then
    alter table public.error_log add constraint error_log_ua_chk
      check (user_agent is null or char_length(user_agent) <= 300) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'error_log_app_chk' and conrelid = 'public.error_log'::regclass) then
    alter table public.error_log add constraint error_log_app_chk
      check (app is null or char_length(app) <= 40) not valid;
  end if;
end $$;

-- admin_users סופר תקלות לכל משתמש בשבוע האחרון
create index if not exists error_log_user_idx on public.error_log (user_id, at desc);

-- (select …) מחושב פעם אחת לשאילתה ולא פעם לכל שורה
drop policy if exists error_read on public.error_log;
create policy error_read on public.error_log
  for select to authenticated using ((select public.is_admin()) or user_id = auth.uid());

drop policy if exists error_clear on public.error_log;
create policy error_clear on public.error_log
  for delete to authenticated using ((select public.is_admin()));

-- ------------------------------------------------ 8. העברת מפתחות כרטיסים
-- אותה חתימה ואותה התנהגות, אבל קידומת ריקה או בלי נקודתיים הייתה
-- תופסת כל כרטיס של המשתמש ('' מתאים להכול, 'fg' מתאים גם ל-'fgx:…').
-- ו-_ או % בקידומת היו מתפרשים כתווים כלליים של LIKE.
create or replace function public.remap_card_keys(old_prefix text, deck uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  moved integer;
  pat   text;
begin
  if auth.uid() is null then raise exception 'נדרשת התחברות'; end if;
  if old_prefix is null or length(old_prefix) < 2 or right(old_prefix, 1) <> ':'
    then raise exception 'קידומת לא חוקית: %', coalesce(old_prefix, 'null'); end if;
  if not exists (select 1 from public.decks d where d.id = deck and d.owner_id = auth.uid())
    then raise exception 'החבילה אינה שלך'; end if;

  pat := replace(replace(replace(old_prefix, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with moved_rows as (
    update public.card_state
       set card_key = deck::text || ':' || right(card_key, -length(old_prefix))
     where user_id = auth.uid()
       and card_key like pat escape '\'
       -- שורה שכבר הועברה לא תועבר שוב
       and not exists (
         select 1 from public.card_state c2
          where c2.user_id = auth.uid()
            and c2.card_key = deck::text || ':' || right(public.card_state.card_key, -length(old_prefix)))
    returning 1)
  select count(*) into moved from moved_rows;

  update public.review_log
     set card_key = deck::text || ':' || right(card_key, -length(old_prefix))
   where user_id = auth.uid() and card_key like pat escape '\';

  return moved;
end $$;

revoke all on function public.remap_card_keys(text, uuid) from public, anon;
grant execute on function public.remap_card_keys(text, uuid) to authenticated;

-- ------------------------------------------------------------ 9. רענון
-- PostgREST טוען מחדש את הסכימה, כדי שהעמודות וה-RPC החדשים יהיו זמינים מיד
notify pgrst, 'reload schema';
