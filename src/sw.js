/* שינון ביוכימיה — service worker.
 *
 * VERSION מוחלף בזמן בנייה בטביעת אצבע של index.html (tools/build.mjs),
 * כך שכל דיפלוי מתקין SW חדש ומפנה את הקאש הישן.
 *
 * אסטרטגיה: HTML ונתונים ברשת-תחילה עם נפילה לקאש, כדי שעדכון תוכן יגיע
 * מיד; נכסים שאינם משתנים בקאש-תחילה, כדי שהטעינה תישאר מיידית ואופליין.
 */
const VERSION = '__BUILD__';
const CACHE = 'shinun-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './fonts.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

/* קבצים שתוכנם משתנה בין גרסאות — חייבים לעבור דרך הרשת קודם */
const FRESH = /\/$|index\.html$|\.webmanifest$/;
/* בלי אלה אין אפליקציה אופליין. השאר (גופנים בבנייה מקומית למשל)
   רשות — קובץ חסר לא מכשיל את כל ההתקנה. */
const REQUIRED = ['./', './index.html'];

/* cache:'reload' עוקף את מטמון ה-HTTP (GitHub Pages שומר עשר דקות),
   אחרת SW חדש עלול לשמור בקאש שלו את index.html הישן */
const reloadReq = (u) => (typeof Request === 'function' ? new Request(u, { cache: 'reload' }) : u);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => {
        const p = c.add(reloadReq(u));
        return REQUIRED.includes(u) ? p : p.catch(() => {});
      })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  /* רק קבצי האפליקציה עצמה. קריאות ל-Supabase הן נתונים חיים: כשעברו
     כאן, תשובת הספרייה הראשונה נשמרה בקאש-תחילה והוגשה לנצח, וכרטיסים
     חדשים לא הופיעו עד איפוס ידני. לאופליין יש לספרייה מראה משלה. */
  if (url.origin !== self.location.origin) return;

  const fresh = request.mode === 'navigate' || FRESH.test(url.pathname);

  if (fresh) {
    /* רשת-תחילה: הגרסה החדשה מנצחת, והקאש הוא רשת ביטחון לאופליין.
       no-cache — אימות מול השרת גם כשמטמון ה-HTTP עוד "טרי". בקשת
       ניווט אי אפשר לשכפל עם אפשרויות, ולכן היא נבנית מה-URL. */
    const net = request.mode === 'navigate'
      ? fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' })
      : fetch(request, { cache: 'no-cache' });
    e.respondWith(
      net
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
    );
    return;
  }

  /* קאש-תחילה לשאר — גופנים, אייקונים, נכסים שאינם משתנים בתוך גרסה */
  e.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      });
    }),
  );
});
