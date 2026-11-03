package com.dswwing.tasks;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;

/**
 * Ringing while the app is open, done the way a real phone does it:
 *  - incoming call: the phone's own ringtone on the RING volume (silent mode = no sound,
 *    vibrate mode = vibrate only), not the music volume;
 *  - outgoing call: the normal "ring ring" tone on the CALL volume, in the earpiece.
 */
final class CallRinger {
    private static Ringtone ring;
    private static ToneGenerator tone;
    private static Vibrator vib;
    private static final Handler H = new Handler(Looper.getMainLooper());
    private static Runnable loop, stopper;

    private CallRinger() {}

    @SuppressWarnings("deprecation")
    static synchronized void start(Context c, boolean outgoing) {
        stop();
        final Context ctx = c.getApplicationContext();
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (outgoing) {
            try {
                tone = new ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80);
                tone.startTone(ToneGenerator.TONE_SUP_RINGTONE);   // repeats by itself until stopped
            } catch (Exception e) { tone = null; }
        } else {
            int mode = am == null ? AudioManager.RINGER_MODE_NORMAL : am.getRingerMode();
            if (mode == AudioManager.RINGER_MODE_NORMAL) {
                try {
                    Uri u = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE);
                    if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
                    ring = u == null ? null : RingtoneManager.getRingtone(ctx, u);
                    if (ring == null) ring = RingtoneManager.getRingtone(ctx, android.provider.Settings.System.DEFAULT_RINGTONE_URI);
                    if (ring != null) {
                        ring.setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
                        if (Build.VERSION.SDK_INT >= 28) ring.setLooping(true);
                        ring.play();
                        if (Build.VERSION.SDK_INT < 28) {
                            loop = new Runnable() {
                                @Override public void run() {
                                    synchronized (CallRinger.class) {
                                        if (ring == null) return;
                                        try { if (!ring.isPlaying()) ring.play(); } catch (Exception ignored) {}
                                    }
                                    H.postDelayed(this, 1000);
                                }
                            };
                            H.postDelayed(loop, 1000);
                        }
                    }
                } catch (Exception e) { ring = null; }
            }
            if (mode != AudioManager.RINGER_MODE_SILENT) {
                try {
                    vib = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
                    long[] p = {0, 900, 700};
                    if (vib != null && vib.hasVibrator()) {
                        if (Build.VERSION.SDK_INT >= 26) vib.vibrate(VibrationEffect.createWaveform(p, 0));
                        else vib.vibrate(p, 0);
                    }
                } catch (Exception e) { vib = null; }
            }
        }
        stopper = CallRinger::stop;          // never ring forever if the page forgets to stop it
        H.postDelayed(stopper, 60000);
    }

    @SuppressWarnings("deprecation")
    static synchronized void stop() {
        if (loop != null) { H.removeCallbacks(loop); loop = null; }
        if (stopper != null) { H.removeCallbacks(stopper); stopper = null; }
        if (ring != null) { try { ring.stop(); } catch (Exception ignored) {} ring = null; }
        if (tone != null) { try { tone.stopTone(); tone.release(); } catch (Exception ignored) {} tone = null; }
        if (vib != null) { try { vib.cancel(); } catch (Exception ignored) {} vib = null; }
    }
}
