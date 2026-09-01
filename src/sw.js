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

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
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
  const fresh = request.mode === 'navigate' || FRESH.test(url.pathname);

  if (fresh) {
    /* רשת-תחילה: הגרסה החדשה מנצחת, והקאש הוא רשת ביטחון לאופליין */
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
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
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      });
    }),
  );
});
