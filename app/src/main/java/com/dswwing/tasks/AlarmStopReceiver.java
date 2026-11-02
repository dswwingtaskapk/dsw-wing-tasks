package com.dswwing.tasks;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationManagerCompat;

/** "Stop" on the daily-report alarm: silence it without opening the app. It rings again in 5 minutes if the section is still missing. */
public class AlarmStopReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        try { NotificationManagerCompat.from(c).cancel(PushService.ALARM_ID); } catch (Exception ignored) {}
    }
}
