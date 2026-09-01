# שינון ביוכימיה

אפליקציית תרגול למבחן. שלוש חבילות: קבוצות פונקציונליות, יסודות עיקריים וקורט, ועץ האיזומרים.

## מבנה

| נתיב | מה זה |
|---|---|
| `functional-groups.html` | **קובץ המקור.** כל האפליקציה בקובץ אחד — דאטה, מנוע ציור מולקולות, מנוע חידון, תצוגה. כאן עורכים. |
| `www/` | תוצר בנייה. `index.html` + `manifest.webmanifest` + `sw.js` + `fonts.css` + אייקונים. |
| `android/` | פרויקט Capacitor לאנדרואיד. תוצר של `npx cap add android` — לא עורכים ידנית חוץ מהגדרות. |
| `tools/` | סקריפטי בנייה (בלי תלויות חיצוניות). |

## פקודות

```bash
npm run build     # functional-groups.html → www/index.html
npm run fonts     # מוריד גופנים מ-Google ומטמיע ב-www/fonts.css (דורש רשת, פעם אחת)
npm run icons     # מייצר אייקוני PWA ל-www/icons
npm run serve     # שרת מקומי לבדיקה, כולל כתובת לטלפון ברשת
npm run sync      # build + העתקה לפרויקט האנדרואיד
npm run apk       # sync + בניית APK (דורש JDK 21 ו-Android SDK)
```

לאחר `npx cap add android` יש להריץ פעם אחת:

```bash
python3 tools/make-android-icons.py
```

## סביבת הבנייה שהותקנה

| רכיב | נתיב |
|---|---|
| JDK 21 | `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home` (מקובע ב-`android/gradle.properties`) |
| Android SDK | `/opt/homebrew/share/android-commandlinetools` (מקובע ב-`android/local.properties`) |
| רכיבים | `platform-tools`, `platforms;android-35`, `build-tools;35.0.0` |

`npm run apk` דורש את משתני הסביבה:

```bash
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT="$ANDROID_HOME"
```

התוצר: `android/app/build/outputs/apk/debug/app-debug.apk` (~4.2MB).
ה-APK חתום במפתח debug — מספיק להתקנה עצמית, לא לחנות.

## הוספת חבילה חדשה

הכול ב-`functional-groups.html`:

1. מוסיפים מערך דאטה (כמו `GROUPS` / `ELEMENTS` / `ISO`).
2. כותבים בונה שאלות שמחזיר `{key, label, prompt, optionKind, options, answer, why}`.
3. מוסיפים רשומה ל-`DECKS` עם `modes` ו-`build(mode)`.

`prompt.kind` הנתמכים: `mol` (מבנה), `text`, `element` (סמל גדול), `pair` (שני מבנים).
`optionKind`: `text` או `pic`.

## מנוע ציור המולקולות

מולקולה = אטומים בקואורדינטות רשת + קשרים בין אינדקסים.

```js
{ a:[A('R',0,1), A('C',1,1), A('O',1,2)],
  b:[[0,1,1], [1,2,2]] }
```

סוגי קשר: `1` יחיד · `2` כפול · `3` טריז (קדימה מהמישור) · `4` מקווקו (אחורה).
צבע האטום נגזר מהיסוד. אורך הקשר מחושב לפי גבול תיבת התווית, כך שתוויות ארוכות
(`OH`, `CH₂OH`) לא בולעות את הקו.

## התקנה בטלפון בלי APK

`npm run serve`, פותחים בטלפון את הכתובת שמודפסת, ובכרום: תפריט ← התקנת אפליקציה.
מקבלים אייקון, מסך מלא ועבודה אופליין (service worker).
