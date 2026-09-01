-- יומן תקלות + הרשאת אדמין. להרצה פעם אחת ב-SQL Editor.

-- מי רשאי לקרוא את היומן. אין כאן מדיניות לפי מייל בקוד —
-- החברות בטבלה היא ההרשאה, וניתן לשנות אותה בלי לגעת באפליקציה.
create table if not exists public.admins (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

-- שנה את המייל אם צריך, או הוסף שורות נוספות
insert into public.admins (user_id)
select id from auth.users where lower(email) = lower('shlomo.assaf7@gmail.com')
on conflict do nothing;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

create table if not exists public.error_log (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users (id) on delete set null,
  at         timestamptz not null default now(),
  kind       text not null,               -- client · fetch · function · promise
  message    text not null,
  context    jsonb,                       -- כתובת, מסך, סטטוס, גוף התשובה
  user_agent text,
  app        text                         -- חתימת הבנייה, לזיהוי הגרסה
);

create index if not exists error_log_at_idx on public.error_log (at desc);

alter table public.admins    enable row level security;
alter table public.error_log enable row level security;

-- כל אחד רואה רק את שורת האדמין שלו, כדי שהאפליקציה תוכל לשאול "אני אדמין?"
drop policy if exists admins_self on public.admins;
create policy admins_self on public.admins
  for select to authenticated using (user_id = auth.uid());

-- כתיבה: כל משתמש מחובר מדווח על עצמו בלבד
drop policy if exists error_write on public.error_log;
create policy error_write on public.error_log
  for insert to authenticated with check (user_id = auth.uid());

-- קריאה: אדמין רואה את כל התקלות; משתמש רגיל רק את שלו
drop policy if exists error_read on public.error_log;
create policy error_read on public.error_log
  for select to authenticated using (public.is_admin() or user_id = auth.uid());

-- ניקוי: אדמין בלבד
drop policy if exists error_clear on public.error_log;
create policy error_clear on public.error_log
  for delete to authenticated using (public.is_admin());
