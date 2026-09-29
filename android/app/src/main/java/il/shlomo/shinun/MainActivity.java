package il.shlomo.shinun;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        /* בלי תוסף @capacitor/app, כפתור החזרה סוגר את ה-Activity.
           מעבירים אותו להיסטוריה של ה-WebView, שם האפליקציה מנהלת את המסכים;
           רק כשאין לאן לחזור הוא יוצא. */
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge() != null ? getBridge().getWebView() : null;
                if (wv != null && wv.canGoBack()) {
                    wv.goBack();
                    return;
                }
                /* מאנדרואיד 12 היציאה רק מעבירה לרקע — חייבים להדליק שוב */
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
