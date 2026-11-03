package com.dswwing.tasks;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Typeface;

import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * WhatsApp-style chat notifications: one notification per conversation, new messages stack
 * inside it, each sender has a round coloured avatar with their initials.
 */
final class ChatNotifs {
    private static final String PREFS = "wt_chat_notifs";
    private static final int KEEP = 7;            // messages shown inside one notification
    static final String GROUP = "wingtasks_messages";
    static final int SUMMARY_ID = 99000;

    private ChatNotifs() {}

    static int notifId(String conv) {
        return 100000 + ((conv == null ? 0 : conv.hashCode()) & 0xffff);
    }

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** add a message to this conversation and return the recent messages (oldest first) */
    static synchronized JSONArray add(Context c, String conv, String sender, String text, long at) {
        JSONArray a;
        try { a = new JSONArray(sp(c).getString(conv, "[]")); } catch (Exception e) { a = new JSONArray(); }
        try {
            JSONObject m = new JSONObject();
            m.put("n", sender); m.put("t", text); m.put("at", at);
            a.put(m);
        } catch (Exception ignored) {}
        JSONArray out = new JSONArray();
        for (int i = Math.max(0, a.length() - KEEP); i < a.length(); i++) out.put(a.opt(i));
        sp(c).edit().putString(conv, out.toString()).apply();
        return out;
    }

    static synchronized int pending(Context c) {
        int n = 0;
        for (Object v : sp(c).getAll().values()) {
            try { n += new JSONArray(String.valueOf(v)).length(); } catch (Exception ignored) {}
        }
        return n;
    }

    /** the person opened this chat: remove its notification and forget its messages */
    static synchronized void clear(Context c, String conv) {
        if (conv == null || conv.isEmpty()) return;
        sp(c).edit().remove(conv).apply();
        try {
            NotificationManagerCompat nm = NotificationManagerCompat.from(c);
            nm.cancel(notifId(conv));
            if (sp(c).getAll().isEmpty()) nm.cancel(SUMMARY_ID);
        } catch (Exception ignored) {}
    }

    static synchronized void clearAll(Context c) {
        try { sp(c).edit().clear().apply(); } catch (Exception ignored) {}
    }

    /* ---------- round avatar with initials, colour picked from the name ---------- */
    private static final int[] COLORS = {0xFF1F6F6A, 0xFF3B82F6, 0xFF8B5CF6, 0xFFE11D48, 0xFFF59E0B, 0xFF10B981, 0xFF0EA5E9, 0xFFEC4899, 0xFF6366F1, 0xFF84CC16};

    static String initials(String name) {
        String n = name == null ? "" : name.trim();
        if (n.isEmpty()) return "?";
        String[] w = n.split("\\s+");
        String s = w[0].substring(0, 1) + (w.length > 1 ? w[1].substring(0, 1) : "");
        return s.toUpperCase();
    }

    static Bitmap avatar(Context c, String name) {
        try {
            int px = (int) (64 * c.getResources().getDisplayMetrics().density);
            Bitmap b = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888);
            Canvas cv = new Canvas(b);
            Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
            bg.setColor(COLORS[((name == null ? 0 : name.hashCode()) & 0x7fffffff) % COLORS.length]);
            cv.drawCircle(px / 2f, px / 2f, px / 2f, bg);
            Paint tx = new Paint(Paint.ANTI_ALIAS_FLAG);
            tx.setColor(0xFFFFFFFF);
            tx.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
            tx.setTextSize(px * 0.40f);
            tx.setTextAlign(Paint.Align.CENTER);
            String s = initials(name);
            Rect r = new Rect();
            tx.getTextBounds(s, 0, s.length(), r);
            cv.drawText(s, px / 2f, px / 2f + r.height() / 2f, tx);
            return b;
        } catch (Throwable t) { return null; }
    }
}
