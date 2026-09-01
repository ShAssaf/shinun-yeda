-- ניקוי נושאים כפולים + מניעה שזה יקרה שוב.
--
-- שים לב: ה-SQL Editor רץ בהרשאת service role ועוקף RLS, ולכן הפקודות
-- כאן נוגעות בנושאים של כל המשתמשים, לא רק בשלך. זה מה שרצוי לניקוי
-- הבלגן שנוצר, אבל כדאי להריץ קודם את שאילתת הבדיקה ולראות מה יימחק.

-- ------------------------------------------------------------ 1. בדיקה
-- מה קיים כרגע, וכמה עותקים לכל נושא
select owner_id, kind, title, count(*) as copies,
       min(created_at) as keeps, max(created_at) as newest
from public.decks
group by owner_id, kind, title
having count(*) > 1
order by copies desc;

-- ------------------------------------------------------------ 2. מחיקה
-- שומר את העותק הראשון שנוצר בכל (בעלים, סוג, כותרת) — זה שאליו
-- הועברה היסטוריית התזמון — ומוחק את השאר.
with ranked as (
  select id,
         row_number() over (partition by owner_id, kind, title
                            order by created_at, id) as rn
  from public.decks
)
delete from public.decks
where id in (select id from ranked where rn > 1);

-- ------------------------------------------------------------ 3. מניעה
-- מכאן והלאה הוספה כפולה תיכשל בשרת במקום ליצור עותק נוסף בשקט.
create unique index if not exists decks_owner_kind_title_uniq
  on public.decks (owner_id, kind, title);

-- ------------------------------------------------------------ 4. אימות
select owner_id, count(*) as decks, sum(item_count) as items
from public.decks
group by owner_id;
