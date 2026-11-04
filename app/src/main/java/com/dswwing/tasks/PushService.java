package com.dswwing.tasks;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Map;

/** Receives phone push messages sent by the push server (Cloudflare Worker) and shows them as notifications. */
public class PushService extends FirebaseMessagingService {

    /* v2: the Wing Tasks chime. A channel's sound can't change once made, so the old channel is replaced. */
    static final String CHANNEL = "wingtasks_alerts_v2";
    static final String OLD_CHANNEL = "wingtasks_alerts";
    static final String CALL_CHANNEL = "wingtasks_calls";
    static final String ALARM_CHANNEL = "wingtasks_report_alarm";
    static final int ALARM_ID = 6100;   // daily report is late
    static final int CMDT_ID = 6200;    // report not yet sent to the Commandant
    static final int TEAL = 0xFF1F6F6A, RED = 0xFFD23C3C;

    static Uri chime(Context c) {
        return Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + c.getPackageName() + "/" + R.raw.wing_chime);
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Task and report alerts", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("New tasks, chat messages, deadlines and daily report reminders");
                ch.setSound(chime(c), new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
                ch.enableVibration(true);
                ch.setVibrationPattern(new long[]{0, 250, 120, 250});
                ch.enableLights(true);
                ch.setLightColor(TEAL);
                ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                nm.createNotificationChannel(ch);
            }
            try { if (nm.getNotificationChannel(OLD_CHANNEL) != null) nm.deleteNotificationChannel(OLD_CHANNEL); } catch (Exception ignored) {}
            if (nm.getNotificationChannel(CALL_CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CALL_CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Rings like a phone call when someone calls you in Wing Tasks");
                ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                        new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
                ch.enableVibration(true);
                ch.setVibrationPattern(new long[]{0, 900, 700, 900, 700});
                ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                nm.createNotificationChannel(ch);
            }
            NotificationChannel al = nm.getNotificationChannel(ALARM_CHANNEL);
            if (al == null) {
                NotificationChannel ch = new NotificationChannel(ALARM_CHANNEL, "Report alarms", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Rings when a daily report section is late, or the report is not yet sent to the Commandant");
                Uri snd = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
                if (snd == null) snd = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
                ch.setSound(snd, new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
                ch.enableVibration(true);
                ch.setVibrationPattern(new long[]{0, 1000, 500, 1000, 500});
                ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                ch.setBypassDnd(true);
                nm.createNotificationChannel(ch);
            } else if (!"Report alarms".contentEquals(al.getName())) {
                // only the name and description may change on an existing channel
                NotificationChannel ch = new NotificationChannel(ALARM_CHANNEL, "Report alarms", al.getImportance());
                ch.setDescription("Rings when a daily report section is late, or the report is not yet sent to the Commandant");
                nm.createNotificationChannel(ch);
            }
        }
    }

    static int callNotifId(String callId) {
        return 7000 + ((callId == null ? 0 : callId.hashCode()) & 0xffff);
    }

    @Override
    public void onNewToken(String token) {
        MainActivity.onNewToken(token);
    }

    private boolean canPost() {
        return !(Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED);
    }

    private PendingIntent open(String tab, String id, String date, String act, int rc) {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra("ntab", tab);
        i.putExtra("nid", id);
        i.putExtra("ndate", date);
        if (act != null) i.putExtra("nact", act);
        return PendingIntent.getActivity(this, rc, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent stopper(int notifId) {
        Intent stop = new Intent(this, AlarmStopReceiver.class);
        stop.putExtra("nid", notifId);
        return PendingIntent.getBroadcast(this, notifId + 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /* ---------- the look: app logo, large readable title and message ---------- */
    private static Bitmap logo;
    private Bitmap logo() {
        if (logo != null) return logo;
        try {
            Drawable dr = ContextCompat.getDrawable(this, R.mipmap.ic_launcher);   // works for the round/adaptive icon too
            if (dr == null) return null;
            int px = (int) (64 * getResources().getDisplayMetrics().density);
            Bitmap b = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888);
            Canvas cv = new Canvas(b);
            dr.setBounds(0, 0, px, px);
            dr.draw(cv);
            logo = b;
        } catch (Throwable ignored) { logo = null; }
        return logo;
    }

    private NotificationCompat.Builder pretty(String channel, String title, String body, int color) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(color)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().setBigContentTitle(title).bigText(body))
                .setShowWhen(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        Bitmap lg = logo();
        if (lg != null) b.setLargeIcon(lg);
        return b;
    }

    private void post(int id, Notification n) {
        try { NotificationManagerCompat.from(this).notify(id, n); } catch (SecurityException ignored) {}
    }

    /* ---------- chat messages ---------- */
    private static boolean empty(String s) { return s == null || s.trim().isEmpty(); }

    private static boolean isMessage(String tab, Map<String, String> d) {
        if ("dm".equals(tab)) return true;
        if (!"chat".equals(tab)) return false;
        if (!empty(d.get("msg"))) return true;
        String b = d.get("body") == null ? "" : d.get("body");
        return b.contains(" · ") && b.contains(": ") && !b.startsWith("New task from") && !b.contains(" completed: ");
    }

    private void showMessage(String tab, Map<String, String> d) {
        String id = d.get("id") == null ? "" : d.get("id");
        String conv = tab + ":" + id;
        if (MainActivity.visible && conv.equals(MainActivity.activeConv)) return;   // that chat is open on screen
        String sender = d.get("name"), text = d.get("msg"), title = d.get("conv");
        if (empty(text)) {                     // older app versions send only "Name: message"
            String b = d.get("body") == null ? "" : d.get("body");
            if ("dm".equals(tab)) {
                if (b.startsWith("DSW Wing · ")) { title = "DSW Wing"; b = b.substring(11); }
                int k = b.indexOf(": ");
                if (k > 0) { if (empty(sender)) sender = b.substring(0, k); text = b.substring(k + 2); } else text = b;
            } else {
                int k1 = b.indexOf(" · "), k2 = k1 < 0 ? -1 : b.indexOf(": ", k1);
                if (k1 > 0 && k2 > k1) { if (empty(sender)) sender = b.substring(0, k1); title = b.substring(k1 + 3, k2); text = b.substring(k2 + 2); }
                else text = b;
            }
        }
        if ("dm".equals(tab) && "wing".equals(id) && empty(title)) title = "DSW Wing";
        if (empty(sender)) sender = "Wing Tasks";
        boolean group = !empty(title);
        long at = System.currentTimeMillis();
        JSONArray hist = ChatNotifs.add(this, conv, sender, text, at);

        NotificationCompat.MessagingStyle st = new NotificationCompat.MessagingStyle(new Person.Builder().setName("You").setKey("me").build());
        if (group) { st.setConversationTitle(title); st.setGroupConversation(true); }
        for (int i = 0; i < hist.length(); i++) {
            JSONObject m = hist.optJSONObject(i);
            if (m == null) continue;
            String n = m.optString("n", "Wing Tasks");
            Person.Builder pb = new Person.Builder().setName(n).setKey(n);
            Bitmap av = ChatNotifs.avatar(this, n);
            if (av != null) pb.setIcon(IconCompat.createWithBitmap(av));
            st.addMessage(new NotificationCompat.MessagingStyle.Message(m.optString("t", ""), m.optLong("at", at), pb.build()));
        }
        int nid = ChatNotifs.notifId(conv);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat).setColor(TEAL)
                .setStyle(st)
                .setContentTitle(group ? title : sender)
                .setContentText(group ? sender + ": " + text : text)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setAutoCancel(true)
                .setWhen(at).setShowWhen(true)
                .setNumber(hist.length())
                .setGroup(ChatNotifs.GROUP)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setContentIntent(open(tab, id, null, null, nid));
        Bitmap large = group ? logo() : ChatNotifs.avatar(this, sender);
        if (large != null) b.setLargeIcon(large);
        if (Build.VERSION.SDK_INT < 26) b.setSound(chime(this)).setVibrate(new long[]{0, 250, 120, 250}).setLights(TEAL, 800, 1600);
        post(nid, b.build());

        // a quiet summary that bundles several chats together, like WhatsApp
        int total = ChatNotifs.pending(this);
        NotificationCompat.Builder sum = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat).setColor(TEAL)
                .setContentTitle("Wing Tasks")
                .setContentText(total + " new message" + (total == 1 ? "" : "s"))
                .setStyle(new NotificationCompat.InboxStyle().setSummaryText(total + " new message" + (total == 1 ? "" : "s")))
                .setGroup(ChatNotifs.GROUP).setGroupSummary(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .setContentIntent(open("", "", "", null, ChatNotifs.SUMMARY_ID));
        post(ChatNotifs.SUMMARY_ID, sum.build());
    }

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        Map<String, String> d = msg.getData();
        if (d == null || d.isEmpty()) return;
        String tab = d.get("tab") == null ? "" : d.get("tab");
        ensureChannel(this);

        // the caller hung up or nobody answered: stop ringing, leave a "missed call" note
        if ("callend".equals(tab)) {
            try { NotificationManagerCompat.from(this).cancel(callNotifId(d.get("id"))); } catch (Exception ignored) {}
            if (MainActivity.visible || !canPost()) return;
            String who = d.get("name") != null && !d.get("name").isEmpty() ? d.get("name") : "a member";
            int rc = (int) (System.currentTimeMillis() & 0x7fffffff);
            NotificationCompat.Builder b = pretty(CHANNEL, "Missed call", "from " + who, TEAL)
                    .setCategory("missed_call")
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setContentIntent(open("dm", d.get("dm"), null, null, rc));
            if (Build.VERSION.SDK_INT < 26) b.setSound(chime(this));
            post(rc, b.build());
            return;
        }

        // the daily report is late: ring like an alarm for about a minute (even when the app is open)
        if ("alarm".equals(tab)) {
            if (!canPost()) return;
            String body = d.get("body") != null ? d.get("body") : "Please submit your daily report section now.";
            PendingIntent openIt = open("daily", null, d.get("date"), "alarm", ALARM_ID);
            NotificationCompat.Builder b = pretty(ALARM_CHANNEL, "⏰ Daily report is late", body, RED)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setAutoCancel(true)
                    .setTimeoutAfter(60000)
                    .setFullScreenIntent(openIt, true)
                    .setContentIntent(openIt)
                    .addAction(0, "Stop", stopper(ALARM_ID))
                    .addAction(0, "Open report", openIt);
            if (Build.VERSION.SDK_INT < 26) {
                b.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)).setVibrate(new long[]{0, 1000, 500, 1000, 500});
            }
            Notification n = b.build();
            n.flags |= Notification.FLAG_INSISTENT;
            post(ALARM_ID, n);
            return;
        }

        // the report has not been sent to the Commandant yet: alarm with a big screen and a Done button
        if ("cmdt".equals(tab)) {
            if (!canPost()) return;
            String date = d.get("date");
            String body = d.get("body") != null ? d.get("body") : "The daily report has not been sent to the Commandant yet.";
            PendingIntent show = open("cmdt", null, date, "show", CMDT_ID);
            PendingIntent done = open("cmdt", null, date, "done", CMDT_ID + 2);
            NotificationCompat.Builder b = pretty(ALARM_CHANNEL, "⏰ Send the report to Commandant Sir", body, RED)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setAutoCancel(true)
                    .setTimeoutAfter(60000)
                    .setFullScreenIntent(show, true)
                    .setContentIntent(show)
                    .addAction(0, "Stop", stopper(CMDT_ID))
                    .addAction(0, "Done ✓ Sent", done);
            if (Build.VERSION.SDK_INT < 26) {
                b.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)).setVibrate(new long[]{0, 1000, 500, 1000, 500});
            }
            Notification n = b.build();
            n.flags |= Notification.FLAG_INSISTENT;
            post(CMDT_ID, n);
            MainActivity.showAlarmInApp("cmdt", date);     // app open: its big screen appears too, the sound keeps going
            return;
        }

        if (!canPost()) return;

        // chat messages: WhatsApp style, one notification per chat with the messages stacked inside
        if (isMessage(tab, d)) { showMessage(tab, d); return; }

        // someone is calling: ring like a phone call, full screen over the lock screen
        if ("call".equals(tab)) {
            if (MainActivity.visible) return;   // the app is open: it shows the call screen itself
            String id = d.get("id");
            String who = d.get("name") != null && !d.get("name").isEmpty() ? d.get("name") : "Wing Tasks";
            int nid = callNotifId(id);
            PendingIntent full = open("call", id, null, "open", nid);
            PendingIntent accept = open("call", id, null, "accept", nid + 1);
            PendingIntent decline = open("call", id, null, "decline", nid + 2);
            NotificationCompat.Builder b = new NotificationCompat.Builder(this, CALL_CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat).setColor(TEAL)
                    .setContentTitle(who)
                    .setContentText("Incoming audio call · Wing Tasks")
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .setTimeoutAfter(45000)
                    .setFullScreenIntent(full, true)
                    .setContentIntent(full)
                    .addAction(0, "Decline", decline)
                    .addAction(0, "Accept", accept);
            Bitmap lg = logo();
            if (lg != null) b.setLargeIcon(lg);
            if (Build.VERSION.SDK_INT < 26) {
                Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
                b.setSound(ring).setVibrate(new long[]{0, 900, 700, 900, 700});
            }
            Notification n = b.build();
            n.flags |= Notification.FLAG_INSISTENT;   // keep ringing until answered, declined or timed out
            post(nid, n);
            return;
        }

        String title = d.get("title") != null && !d.get("title").isEmpty() ? d.get("title") : "Wing Tasks";
        String body = d.get("body") != null ? d.get("body") : "";
        int rc = (int) (System.currentTimeMillis() & 0x7fffffff);
        NotificationCompat.Builder b = pretty(CHANNEL, title, body, TEAL)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(open(tab, d.get("id"), d.get("date"), null, rc));
        if (Build.VERSION.SDK_INT < 26) b.setSound(chime(this)).setVibrate(new long[]{0, 250, 120, 250}).setLights(TEAL, 800, 1600);
        post(rc, b.build());
    }
}
