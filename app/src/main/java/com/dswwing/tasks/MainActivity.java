package com.dswwing.tasks;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.app.NotificationManagerCompat;
import androidx.webkit.WebViewAssetLoader;

import com.google.firebase.messaging.FirebaseMessaging;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + HOST + "/assets/index.html";

    private static final int REQ_FILE = 4711;
    private static final int REQ_MIC = 78;
    private PermissionRequest pendingMic;
    private ValueCallback<Uri[]> filePathCallback;
    static volatile boolean visible = false;
    static String pushToken = null;
    private static MainActivity instance;
    private boolean pageLoaded = false;
    private String pendingOpenJs = null;
    private WebView web;
    private WebViewAssetLoader loader;

    static void onNewToken(String t) {
        pushToken = t;
        final MainActivity a = instance;
        if (a != null) a.runOnUiThread(a::deliverToken);
    }

    private static String clean(String s) {
        return s == null ? "" : s.replaceAll("[^A-Za-z0-9_:.@-]", "");
    }

    private void deliverToken() {
        if (!pageLoaded || pushToken == null || web == null) return;
        web.evaluateJavascript("window.__nativeToken='" + clean(pushToken) + "';window.dispatchEvent(new Event('fcmtoken'));", null);
    }

    private void deliverOpen() {
        if (!pageLoaded || pendingOpenJs == null || web == null) return;
        web.evaluateJavascript(pendingOpenJs, null);
        pendingOpenJs = null;
    }

    private void handleIntent(Intent in) {
        if (in == null) return;
        String tab = clean(in.getStringExtra("ntab")); if (tab.isEmpty()) tab = clean(in.getStringExtra("tab"));
        String id = clean(in.getStringExtra("nid")); if (id.isEmpty()) id = clean(in.getStringExtra("id"));
        String date = clean(in.getStringExtra("ndate")); if (date.isEmpty()) date = clean(in.getStringExtra("date"));
        String act = clean(in.getStringExtra("nact"));
        if (tab.isEmpty() && id.isEmpty() && date.isEmpty()) return;
        in.removeExtra("ntab"); in.removeExtra("nid"); in.removeExtra("ndate"); in.removeExtra("tab"); in.removeExtra("id"); in.removeExtra("date"); in.removeExtra("nact");
        if ("call".equals(tab)) {
            // an incoming call: stop the ringing notification and show the app over the lock screen
            try { NotificationManagerCompat.from(this).cancel(PushService.callNotifId(id)); } catch (Throwable ignored) {}
            showOverLock(true);
        }
        if ("cmdt".equals(tab)) {
            // the "send to Commandant" alarm: show the big reminder screen, even over the lock screen
            if ("done".equals(act)) { try { NotificationManagerCompat.from(this).cancel(PushService.CMDT_ID); } catch (Throwable ignored) {} }
            else showOverLock(true);
        }
        pendingOpenJs = "window.__pendingOpen={tab:'" + tab + "',id:'" + id + "',date:'" + date + "',act:'" + act + "'};window.dispatchEvent(new Event('nativeopen'));";
        deliverOpen();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;
        PushService.ensureChannel(this);
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    pushToken = task.getResult();
                    deliverToken();
                }
            });
        } catch (Throwable ignored) {
            // push is not configured yet (google-services.json missing)
        }

        loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(BG_LIGHT);
        web.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        // phone "autofill" pop-ups made the keyboard close while typing the login on some phones (e.g. Xiaomi)
        if (Build.VERSION.SDK_INT >= 26) web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        setContentView(web);
        applyBars(getSharedPreferences("ui", MODE_PRIVATE).getBoolean("dark", false));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);   // call audio and ringtone must play without a tap
        if (Build.VERSION.SDK_INT >= 23) s.setOffscreenPreRaster(true);   // smoother scrolling

        web.addJavascriptInterface(new Bridge(), "Android");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                deliverToken();
                deliverOpen();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                String sc = u.getScheme();
                if ("blob".equals(sc) || "data".equals(sc) || "javascript".equals(sc) || "about".equals(sc)) return false;
                openExternal(u);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }

            // in-app audio calls ask for the microphone
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean audio = false;
                    for (String r : request.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                    if (!audio) { request.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        if (pendingMic != null) pendingMic.deny();
                        pendingMic = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                });
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                final WebView tmp = new WebView(MainActivity.this);
                tmp.setWebViewClient(new WebViewClient() {
                    private boolean done = false;

                    private void go(Uri u) {
                        if (done || u == null) return;
                        String sc = u.getScheme();
                        if (!"http".equals(sc) && !"https".equals(sc) && !"mailto".equals(sc) && !"tel".equals(sc)) return;
                        done = true;
                        openExternal(u);
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                        go(r.getUrl());
                        return true;
                    }

                    @Override
                    public void onPageStarted(WebView v, String url, Bitmap favicon) {
                        go(Uri.parse(url));
                        v.stopLoading();
                    }
                });
                WebView.WebViewTransport t = (WebView.WebViewTransport) resultMsg.obj;
                t.setWebView(tmp);
                resultMsg.sendToTarget();
                return true;
            }
        });

        // PDF / file downloads (the report "download" button)
        web.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (url.startsWith("blob:")) {
                String mime = (mimetype == null || mimetype.isEmpty()) ? "application/octet-stream" : mimetype.replaceAll("[^a-zA-Z0-9/.+-]", "");
                String name;
                if (mime.contains("pdf")) {
                    name = "WingTasks-Report-" + new SimpleDateFormat("yyyy-MM-dd-HHmm", Locale.US).format(new Date()) + ".pdf";
                } else {
                    name = URLUtil.guessFileName(url, contentDisposition, mimetype).replaceAll("[^a-zA-Z0-9._-]", "_");
                }
                String js = "(function(){var x=new XMLHttpRequest();x.open('GET','" + url + "',true);x.responseType='blob';"
                        + "x.onload=function(){var r=new FileReader();r.onloadend=function(){"
                        + "Android.save(String(r.result).split(',')[1],'" + mime + "','" + name + "');};"
                        + "r.readAsDataURL(x.response);};x.send();})();";
                web.evaluateJavascript(js, null);
            } else {
                openExternal(Uri.parse(url));
            }
        });

        handleIntent(getIntent());
        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(HOME);
        }
    }

    @SuppressWarnings("deprecation")
    private void showOverLock(boolean on) {
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(on); setTurnScreenOn(on); }
        else {
            int f = android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON;
            if (on) getWindow().addFlags(f); else getWindow().clearFlags(f);
        }
    }

    private static final int BG_LIGHT = 0xFFEEF2F2, BG_DARK = 0xFF0D1514, BAR_LIGHT = 0xFF1B625D, BAR_DARK = 0xFF102E2B;

    /** Status bar and navigation bar follow the app theme (light or dark). */
    @SuppressWarnings("deprecation")
    private void applyBars(boolean dark) {
        int bg = dark ? BG_DARK : BG_LIGHT;
        getWindow().setStatusBarColor(dark ? BAR_DARK : BAR_LIGHT);          // teal top bar, white icons
        getWindow().setNavigationBarColor(dark ? 0xFF15201F : 0xFFFFFFFF);    // matches the bottom menu
        int flags = 0;
        if (!dark && Build.VERSION.SDK_INT >= 26) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        getWindow().getDecorView().setSystemUiVisibility(flags);
        if (web != null) web.setBackgroundColor(bg);
        getWindow().getDecorView().setBackgroundColor(bg);
        getSharedPreferences("ui", MODE_PRIVATE).edit().putBoolean("dark", dark).apply();
    }

    /* ---------- phone setup: everything the app needs, asked from inside the app ---------- */
    private static final int REQ_NOTIF = 77, REQ_MIC_SETUP = 79;

    private boolean hasPerm(String p) { return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }

    private String brand() { return (Build.MANUFACTURER == null ? "" : Build.MANUFACTURER).toLowerCase(Locale.ROOT); }

    /** first time: Android's own "Allow" popup. If the person said no before and Android will not ask again: open the settings page. */
    private void askRuntime(String perm, int code, Runnable fallback) {
        android.content.SharedPreferences sp = getSharedPreferences("perm", MODE_PRIVATE);
        boolean askedBefore = sp.getBoolean(perm, false);
        if (hasPerm(perm)) { notifyPermChange(); return; }
        if (!askedBefore || shouldShowRequestPermissionRationale(perm)) {
            sp.edit().putBoolean(perm, true).apply();
            requestPermissions(new String[]{perm}, code);
        } else fallback.run();
    }

    private boolean tryStart(Intent i) {
        try { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(i); return true; } catch (Exception e) { return false; }
    }

    /** Xiaomi / Oppo / Vivo... hide "show on lock screen", "pop-up in background" and "auto-start" in their own pages */
    private void openMakerSettings() {
        String b = brand(), pkg = getPackageName();
        java.util.List<Intent> list = new java.util.ArrayList<>();
        if (b.contains("xiaomi") || b.contains("redmi") || b.contains("poco")) {
            list.add(new Intent("miui.intent.action.APP_PERM_EDITOR").setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity").putExtra("extra_pkgname", pkg));
            list.add(new Intent("miui.intent.action.APP_PERM_EDITOR").putExtra("extra_pkgname", pkg));
            list.add(new Intent().setClassName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"));
        } else if (b.contains("oppo") || b.contains("realme") || b.contains("oneplus")) {
            list.add(new Intent().setClassName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"));
            list.add(new Intent().setClassName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"));
            list.add(new Intent().setClassName("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"));
        } else if (b.contains("vivo") || b.contains("iqoo")) {
            list.add(new Intent().setClassName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"));
            list.add(new Intent().setClassName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"));
        } else if (b.contains("huawei") || b.contains("honor")) {
            list.add(new Intent().setClassName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"));
        } else if (b.contains("infinix") || b.contains("tecno") || b.contains("itel")) {
            list.add(new Intent().setClassName("com.transsion.phonemaster", "com.cyin.himgr.autostart.AutoStartActivity"));
        } else if (b.contains("samsung")) {
            list.add(new Intent().setClassName("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"));
        }
        for (Intent i : list) if (tryStart(i)) return;
        openAppDetails();
    }

    private void notifyPermChange() {
        if (web != null) runOnUiThread(() -> web.evaluateJavascript("window.dispatchEvent(new Event('permchange'))", null));
    }

    private void openAppDetails() {
        try { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); }
        catch (Exception ignored) {}
    }

    private void openExternal(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception e) {
            Toast.makeText(this, "Cannot open this link", Toast.LENGTH_SHORT).show();
        }
    }

    /** Called from the page: saves a file into the phone's Downloads folder. */
    private class Bridge {

        /** ring with the phone's own ringtone on the ring volume (incoming) or the call tone (outgoing) */
        @JavascriptInterface
        public boolean ringStart(boolean outgoing) {
            runOnUiThread(() -> CallRinger.start(MainActivity.this, outgoing));
            return true;
        }

        @JavascriptInterface
        public void ringStop() { runOnUiThread(CallRinger::stop); }

        /** silence a report alarm (late section / Commandant reminder) and stop showing over the lock screen */
        @JavascriptInterface
        public void alarmStop(String which) {
            runOnUiThread(() -> {
                try {
                    NotificationManagerCompat nm = NotificationManagerCompat.from(MainActivity.this);
                    if (!"daily".equals(which)) nm.cancel(PushService.CMDT_ID);
                    if (!"cmdt".equals(which)) nm.cancel(PushService.ALARM_ID);
                } catch (Throwable ignored) {}
                showOverLock(false);
            });
        }

        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public void callAudio(boolean active) {
            runOnUiThread(() -> {
                AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
                if (am == null) return;
                am.setMode(active ? AudioManager.MODE_IN_COMMUNICATION : AudioManager.MODE_NORMAL);
                am.setSpeakerphoneOn(false);
                if (active) getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else { getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); showOverLock(false); }
            });
        }

        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public void setSpeaker(boolean on) {
            runOnUiThread(() -> {
                AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
                if (am != null) am.setSpeakerphoneOn(on);
            });
        }

        /** after declining a call from the lock screen, go back to what the person was doing */
        @JavascriptInterface
        public void moveToBack() {
            runOnUiThread(() -> { showOverLock(false); moveTaskToBack(true); });
        }

        /** Android 14+: is the app allowed to show calls full screen over the lock screen? */
        @JavascriptInterface
        public boolean canFullScreenCalls() {
            try {
                if (Build.VERSION.SDK_INT >= 34) {
                    android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                    return nm == null || nm.canUseFullScreenIntent();
                }
            } catch (Throwable ignored) {}
            return true;
        }

        @JavascriptInterface
        public void openFullScreenSettings() {
            runOnUiThread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= 34) {
                        startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName())));
                        return;
                    }
                } catch (Exception ignored) {}
                openAppDetails();
            });
        }

        /** what is allowed right now, for the in-app "Phone setup" checklist */
        @JavascriptInterface
        public String permState() {
            boolean notif = notificationsEnabled() && (Build.VERSION.SDK_INT < 33 || hasPerm(Manifest.permission.POST_NOTIFICATIONS));
            boolean mic = hasPerm(Manifest.permission.RECORD_AUDIO);
            boolean battery = true;
            try {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
                if (pm != null) battery = pm.isIgnoringBatteryOptimizations(getPackageName());
            } catch (Throwable ignored) {}
            boolean callsOn = true;
            try {
                if (Build.VERSION.SDK_INT >= 26) {
                    android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                    PushService.ensureChannel(MainActivity.this);
                    android.app.NotificationChannel ch = nm == null ? null : nm.getNotificationChannel(PushService.CALL_CHANNEL);
                    callsOn = ch == null || ch.getImportance() >= android.app.NotificationManager.IMPORTANCE_HIGH;
                }
            } catch (Throwable ignored) {}
            return "{\"notif\":" + notif + ",\"mic\":" + mic + ",\"battery\":" + battery + ",\"fullscreen\":" + canFullScreenCalls()
                    + ",\"callChannel\":" + callsOn + ",\"sdk\":" + Build.VERSION.SDK_INT + ",\"brand\":\"" + clean(brand()) + "\"}";
        }

        @JavascriptInterface
        public void askNotifications() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && !hasPerm(Manifest.permission.POST_NOTIFICATIONS))
                    askRuntime(Manifest.permission.POST_NOTIFICATIONS, REQ_NOTIF, () -> openNotifSettings());
                else openNotifSettings();
            });
        }

        @JavascriptInterface
        public void askMic() {
            runOnUiThread(() -> askRuntime(Manifest.permission.RECORD_AUDIO, REQ_MIC_SETUP, () -> openAppDetails()));
        }

        @JavascriptInterface
        public void openCallChannel() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 26 && tryStart(new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()).putExtra(Settings.EXTRA_CHANNEL_ID, PushService.CALL_CHANNEL))) return;
                openNotifSettings();
            });
        }

        @JavascriptInterface
        public void openMaker() { runOnUiThread(() -> openMakerSettings()); }

        @JavascriptInterface
        public void openAppInfo() { runOnUiThread(() -> openAppDetails()); }

        @JavascriptInterface
        public void setDarkBars(boolean dark) {
            runOnUiThread(() -> applyBars(dark));
        }

        @JavascriptInterface
        public void share(String text) {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType("text/plain");
                    i.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                    startActivity(Intent.createChooser(i, "Share Wing Tasks"));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Cannot share right now", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public boolean notificationsEnabled() {
            try { return NotificationManagerCompat.from(MainActivity.this).areNotificationsEnabled(); } catch (Throwable e) { return true; }
        }

        @JavascriptInterface
        public String pushToken() {
            return pushToken == null ? "" : clean(pushToken);
        }

        @JavascriptInterface
        public void openNotifSettings() {
            runOnUiThread(() -> {
                try {
                    Intent i = Build.VERSION.SDK_INT >= 26
                            ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                } catch (Exception e) { openAppDetails(); }
            });
        }

        @JavascriptInterface
        public void openBatterySettings() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
                } catch (Exception e) {
                    try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
                    catch (Exception e2) { openAppDetails(); }
                }
            });
        }
        @JavascriptInterface
        public void save(String base64, String mime, String name) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) throw new Exception("no uri");
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        os.write(data);
                    }
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir != null) dir.mkdirs();
                    try (FileOutputStream os = new FileOutputStream(new File(dir, name))) {
                        os.write(data);
                    }
                }
                final String msg = "Saved to Downloads: " + name;
                runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Could not save the file", Toast.LENGTH_LONG).show());
            }
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // 1) close an open popup  2) let the app go to Home / the parent screen  3) on Home: leave the app
        web.evaluateJavascript(
                "(function(){var d=document.querySelector('.dlg-wrap,.imgview');if(d){d.click();return 1;}var o=document.getElementById('ov');if(o){o.click();return 1;}if(document.body.classList.contains('navopen')){document.body.classList.remove('navopen');return 1;}if(window.__appBack&&window.__appBack())return 1;return 0;})()",
                value -> {
                    if ("1".equals(value)) return;
                    finish();
                });
    }


    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_NOTIF || requestCode == REQ_MIC_SETUP) { notifyPermChange(); return; }
        if (requestCode == REQ_MIC && pendingMic != null) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED)
                pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else pendingMic.deny();
            pendingMic = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        visible = false;
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        try { NotificationManagerCompat.from(this).cancelAll(); } catch (Throwable ignored) {}
        notifyPermChange();   // back from a settings page: refresh the setup checklist
        web.onResume();
    }
}
