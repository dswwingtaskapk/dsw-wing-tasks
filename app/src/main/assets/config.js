/* =====================================================================
   WING TASKS - SETTINGS FILE
   Only this file needs your Firebase details.
   Firebase Console > Project settings (gear icon) > General >
   "Your apps" > the Web app (</>) > "SDK setup and configuration" > Config.
   Copy the values from there and replace every PASTE_HERE below.
   ===================================================================== */
export const firebaseConfig = {
  apiKey: "AIzaSyANsCY29Y2Zj5yzt6x19pJa1kCJNV4PIYU",
  authDomain: "dsw-wing-tasks.firebaseapp.com",
  projectId: "dsw-wing-tasks",
  storageBucket: "dsw-wing-tasks.firebasestorage.app",
  messagingSenderId: "37134371786",
  appId: "1:37134371786:web:4de13343cffd9407b5dd33"
};

/* The Admin signs in with ID "admin". This must be the SAME email that is
   written in firestore.rules (it already is). */
export const ADMIN_EMAIL = "dswwingtaskapk@gmail.com";

/* Phone notification server (Cloudflare Worker). Built in, so nobody has to type it. */
export const PUSH_SERVER = "https://wing-push.dswwingtaskapk.workers.dev";
