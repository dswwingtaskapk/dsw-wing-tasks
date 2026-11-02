package com.dswwing.tasks;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/** Receives phone push messages sent by the push server (Cloudflare Worker) and shows them as notifications. */
public class PushService extends FirebaseMessagingService {

    static final String CHANNEL = "wingtasks_alerts";
    static final String CALL_CHANNEL = "wingtasks_calls";

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Task and report alerts", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("New tasks, chat messages, deadlines and daily report reminders");
                nm.createNotificationChannel(ch);
            }
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
            NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat).setColor(0xFF1F6F6A)
                    .setContentTitle("Missed call")
                    .setContentText("from " + who)
                    .setCategory("missed_call")
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setContentIntent(open("dm", d.get("dm"), null, null, rc));
            try { NotificationManagerCompat.from(this).notify(rc, b.build()); } catch (SecurityException ignored) {}
            return;
        }

        if (MainActivity.visible) return;   // the app is open: the app itself shows calls and the bell shows alerts
        if (!canPost()) return;

        // someone is calling: ring like a phone call, full screen over the lock screen
        if ("call".equals(tab)) {
            String id = d.get("id");
            String who = d.get("name") != null && !d.get("name").isEmpty() ? d.get("name") : "Wing Tasks";
            int nid = callNotifId(id);
            PendingIntent full = open("call", id, null, "open", nid);
            PendingIntent accept = open("call", id, null, "accept", nid + 1);
            PendingIntent decline = open("call", id, null, "decline", nid + 2);
            NotificationCompat.Builder b = new NotificationCompat.Builder(this, CALL_CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat).setColor(0xFF1F6F6A)
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
            if (Build.VERSION.SDK_INT < 26) {
                Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
                b.setSound(ring).setVibrate(new long[]{0, 900, 700, 900, 700});
            }
            Notification n = b.build();
            n.flags |= Notification.FLAG_INSISTENT;   // keep ringing until answered, declined or timed out
            try { NotificationManagerCompat.from(this).notify(nid, n); } catch (SecurityException ignored) {}
            return;
        }

        String title = d.get("title") != null ? d.get("title") : "Wing Tasks";
        String body = d.get("body") != null ? d.get("body") : "";
        int rc = (int) (System.currentTimeMillis() & 0x7fffffff);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xFF1F6F6A)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setContentIntent(open(tab, d.get("id"), d.get("date"), null, rc));
        try {
            NotificationManagerCompat.from(this).notify(rc, b.build());
        } catch (SecurityException ignored) {
        }
    }
}
