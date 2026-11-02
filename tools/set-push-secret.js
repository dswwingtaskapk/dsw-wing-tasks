// Sends service-account.json (in the project folder) to the push server as its secret.
const fs = require("fs"), path = require("path"), { spawn } = require("child_process");
const file = path.join(__dirname, "..", "service-account.json");
if (!fs.existsSync(file)) {
  console.log("\n  service-account.json was not found in the project folder.");
  console.log("  Firebase Console > Project settings > Service accounts > Generate new private key,");
  console.log("  then rename the downloaded file to service-account.json and put it in this folder.\n");
  process.exit(1);
}
const text = fs.readFileSync(file, "utf8");
try { const j = JSON.parse(text); if (!j.private_key || !j.client_email) throw 0; }
catch (e) { console.log("\n  service-account.json is not a valid key file. Download it again.\n"); process.exit(1); }
const bin = path.join(__dirname, "..", "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
const p = spawn(bin, ["secret", "put", "SERVICE_ACCOUNT", "-c", "push-worker/wrangler.toml"], { stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
p.stdin.write(text); p.stdin.end();
p.on("exit", code => {
  if (code === 0) console.log("\n  Done. The push server now has its key. You can delete service-account.json from this folder (keep a copy somewhere safe).\n");
  process.exit(code || 0);
});
