# Wing Tasks — একদম শুরু থেকে setup (নতুন Gmail দিয়ে)

নতুন Gmail: **dswwingtaskapk@gmail.com**
নিচের GitHub username হিসেবে `dswwingtaskapk` ধরে নিয়েছি। অন্য নাম নিলে সব জায়গায় সেই নাম বসাবেন।

## আগে বুঝে নিন: পুরোনো account নষ্ট হবে না
- পুরোনো Gmail, GitHub, Firebase যেমন আছে তেমনই থাকবে। পুরোনো project-গুলো আগের মতোই চলবে।
- এই project-এর folder-এ ঢুকলে নতুন account, অন্য project-এর folder-এ ঢুকলে পুরোনো account। নিজে থেকেই হবে।
- **কখনো `firebase logout` দেবেন না।** দিলে পুরোনো account-ও বের হয়ে যাবে।
- VS Code-এর নিচে বাঁ দিকের Account আইকনে যে account আছে, থাকুক। ওটার সাথে এই কাজের সম্পর্ক নেই।

---

## পর্ব ১ — Chrome-এ নতুন Gmail-এর আলাদা জানালা (৫ মিনিট)
1. Chrome-এর উপরে ডান কোণে আপনার ছবি বা গোল আইকনে ক্লিক → **Add** (বা "Add Chrome profile")।
2. **Sign in** → `dswwingtaskapk@gmail.com` দিয়ে login → নাম দিন **DSW Wing** → একটা রঙ বেছে নিন।
3. এখন দুটো আলাদা Chrome জানালা থাকবে। **নিচের সব website কাজ এই "DSW Wing" জানালায় করবেন।**

*টিপ:* পরে কোনো command browser খুললে, আর সেটা পুরোনো জানালায় খুললে, terminal-এ যে লম্বা link দেখায় সেটা copy করুন। তারপর DSW Wing জানালায় paste করুন।

---

## পর্ব ২ — তিনটা ফ্রি account খোলা (DSW Wing জানালায়)

**GitHub:** https://github.com/signup → **Continue with Google** → নতুন Gmail → username দিন `dswwingtaskapk` → বাকি প্রশ্নে Skip / Free।

**Firebase:** https://console.firebase.google.com → নতুন Gmail দিয়ে ঢুকবে → Terms-এ টিক → Continue।

**Cloudflare:** https://dash.cloudflare.com/sign-up → **Sign up with Google** → নতুন Gmail → Free plan। কিছু জিজ্ঞেস করলে Skip।

---

## পর্ব ৩ — Firebase project বানানো
1. Firebase console → **Create a project** → নাম `dsw-wing-tasks` → Continue → Google Analytics **বন্ধ** → Create project।
2. বাঁ দিকে **Build → Authentication** → **Get started** → **Email/Password** → প্রথম সুইচ **Enable** → Save।
3. **Build → Firestore Database** → **Create database** → Location: `asia-south1 (Mumbai)` → **Start in production mode** → Create।
4. উপরে বাঁ দিকে ⚙️ → **Project settings** → নিচে **Your apps** → **</>** (Web) আইকন → nickname `Wing Tasks Web` → **Register app**।
   যে লেখাটা দেখাবে (apiKey, authDomain …), সেই পেজটা খোলা রাখুন। পর্ব ৫-এ লাগবে।
5. একই পেজে **Add app** → **Android** আইকন → Package name: `com.dswwing.tasks` → **Register app** → **Download google-services.json** → বাকি ধাপে Next, Next, Continue।
6. **Project settings → Service accounts** ট্যাব → **Generate new private key** → Generate key। একটা .json ফাইল নামবে।

---

## পর্ব ৪ — GitHub-এ repository আর চাবি
1. GitHub → উপরে ডানে **+** → **New repository** → নাম `dsw-wing-tasks` → **Public** → আর কিছু টিক দেবেন না → **Create repository**।
2. সেই repository-তে **Settings → Secrets and variables → Actions → New repository secret**:
   - Name `KEYSTORE_BASE64`, Secret: zip-এর `signing-key-KEEP-SAFE\KEYSTORE_BASE64.txt` ফাইল Notepad-এ খুলে **পুরো লেখা** (Ctrl+A, Ctrl+C) → Add secret
   - আবার New repository secret → Name `KEYSTORE_PASSWORD`, Secret: `KEYSTORE_PASSWORD.txt`-এর লেখা → Add secret
3. Push করার চাবি (token): ডানে উপরে ছবি → **Settings** → একদম নিচে **Developer settings** → **Personal access tokens → Tokens (classic)** → **Generate new token (classic)**
   - Note: `vscode`, Expiration: **No expiration**, টিক দিন: **repo** আর **workflow** → **Generate token**
   - `ghp_...` লেখাটা copy করে Notepad-এ রাখুন। একবারই দেখায়।

---

## পর্ব ৫ — Folder, VS Code, ফাইল বসানো
VS Code খুলে **Terminal → New Terminal**:

```
Expand-Archive -Path "$HOME\Downloads\dsw-wing-tasks.zip" -DestinationPath D:\ -Force
```

```
code D:\dsw-wing-tasks
```
নতুন VS Code জানালা খুলবে। **এখন থেকে সব command এই নতুন জানালার terminal-এ** (Terminal → New Terminal) দেবেন।

ফাইল বসানো:
1. VS Code-এ বাঁ দিকে `app/src/main/assets/config.js` খুলুন। Firebase পেজের (পর্ব ৩.৪) মানগুলো একটা একটা করে `PASTE_HERE`-এর জায়গায় বসান। উদ্ধৃতিচিহ্ন `" "` রেখে দেবেন। তারপর Ctrl + S।
2. `google-services.json` (Downloads থেকে) টেনে VS Code-এর বাঁ দিকে **`app`** folder-এর উপর ছাড়ুন।
3. Service account-এর .json ফাইলের নাম বদলে **`service-account.json`** করুন। টেনে project-এর একদম উপরের folder-এ (`D:\dsw-wing-tasks`) ছাড়ুন।

```
npm install
```
দরকারি tools নামায় (২–৩ মিনিট)।

---

## পর্ব ৬ — এই folder-এর জন্য নতুন account পাকা করা

**Git (কে commit করছে):**
```
git init
```

```
git config user.name "DSW Wing"
```

```
git config user.email "dswwingtaskapk@gmail.com"
```
এই দুইটা শুধু এই folder-এর জন্য। অন্য project-এ পুরোনো নামই থাকবে।

**GitHub (কোন account-এ push হবে):** ঠিকানার ভেতরেই username বসানো আছে, তাই এই folder সবসময় নতুন account ব্যবহার করবে।
```
git remote add origin https://dswwingtaskapk@github.com/dswwingtaskapk/dsw-wing-tasks.git
```

**Firebase (কোন Gmail):** পুরোনো account রেখেই নতুনটা যোগ করুন।
```
firebase login:add
```
Browser খুলবে। DSW Wing জানালায় নতুন Gmail বেছে **Allow** দিন।

```
firebase login:use dswwingtaskapk@gmail.com
```
এখন থেকে এই folder-এ Firebase মানেই নতুন Gmail।

```
firebase use --add
```
Arrow key দিয়ে `dsw-wing-tasks-xxxx` বেছে Enter দিন। alias জিজ্ঞেস করলে লিখুন `default`।

**Cloudflare:** শুধু এই project-এ লাগে, তাই অন্য কিছুর সাথে মিশবে না।
```
npm run push:login
```
DSW Wing জানালায় **Allow**।

---

## পর্ব ৭ — Database নিয়ম আর notification server

```
npm run rules
```
"Deploy complete!" দেখলে ঠিক আছে।

```
npm run push:deploy
```
প্রথমবার subdomain-এর নাম চাইলে লিখুন `dswwing`। শেষে `https://wing-push.dswwing.workers.dev` ধরনের ঠিকানা দেখাবে। **copy করে Notepad-এ রাখুন।**

```
npm run push:secret
```
"Done" দেখালে `service-account.json` ফাইলটা Google Drive-এ backup রেখে folder থেকে মুছে দিতে পারেন।

---

## পর্ব ৮ — GitHub-এ পাঠানো আর QR দিয়ে APK

```
git add .
```

```
git commit -m "Wing Tasks first version"
```

```
git branch -M main
```

```
git push -u origin main
```
একটা ছোট জানালা আসবে। **Token** অপশন বেছে পর্ব ৪.৩-এর `ghp_...` paste করুন → Sign in। একবারই চাইবে, তারপর মনে রাখবে।

```
npm run apk
```
৪–৬ মিনিট অপেক্ষা করুন। QR এলে phone-এর camera দিয়ে scan → Download → **Install** (প্রথমবার "unknown apps" অনুমতি চাইলে Allow)।

---

## পর্ব ৯ — App প্রথমবার চালু
1. Login screen-এর নিচে **Admin: first-time setup** → নতুন password দিন → **Create Admin account**। পরের বার থেকে ID `admin`।
2. **More → Notifications** → Push server address-এ পর্ব ৭-এর ঠিকানা paste → **Save server address** → **Run notification checkup + test** → সব সবুজ হওয়া চাই।
3. **More → Admin** → নিচে ডানে **Add member** → সদস্যদের ID আর password বানান।
4. **More → Admin → Daily Reports** → allocation আর deadline → **Save defaults**।

---

## পরে নিয়মিত কাজ
এই project-এ কিছু বদলালে (VS Code-এ `D:\dsw-wing-tasks` খোলা থাকতে হবে):

```
git add .
```

```
git commit -m "কী বদলালেন"
```

```
git push
```

```
npm run apk
```
Phone-এ app খুললেই "New version ready → Update" দেখাবে।

**অন্য project-এ যেতে:** VS Code-এ **File → Open Folder** দিয়ে সেই project খুলুন। সেখানে আগের মতোই পুরোনো account কাজ করবে। কিছু বদলাতে হবে না।

**কোন account চলছে দেখতে চাইলে** (যে folder খোলা, তার terminal-এ):

```
git config user.email
```

```
firebase login:list
```

**`signing-key-KEEP-SAFE` folder Google Drive-এ backup রাখুন।** হারালে পরের update install হবে না।
