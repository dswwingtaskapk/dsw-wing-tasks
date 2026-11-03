package com.dswwing.tasks;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationManagerCompat;

/** "Stop" on a report alarm: silence it without opening the app. It rings again in 5 minutes if it is still not done. */
public class AlarmStopReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        int id = i == null ? PushService.ALARM_ID : i.getIntExtra("nid", PushService.ALARM_ID);
        try { NotificationManagerCompat.from(c).cancel(id); } catch (Exception ignored) {}
    }
}
