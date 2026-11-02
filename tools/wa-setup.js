// Checks the WhatsApp connection and creates the report template. Usage: npm run wa:setup
const fs = require("fs"), path = require("path"), dns = require("dns");
try { dns.setDefaultResultOrder("ipv4first"); } catch (e) {}
const root = path.join(__dirname, "..");
const verifyFile = path.join(__dirname, ".wa-verify.txt");
const cfg = fs.readFileSync(path.join(root, "app/src/main/assets/config.js"), "utf8");
const server = (cfg.match(/PUSH_SERVER\s*=\s*"([^"]+)"/) || [])[1];
if (!fs.existsSync(verifyFile)) { console.log("\n  Run npm run wa:secret first.\n"); process.exit(1); }
const key = fs.readFileSync(verifyFile, "utf8").trim();
(async () => {
  console.log("\n  Checking WhatsApp through " + server + " ...\n");
  let j;
  try { j = await (await fetch(server + "/wa/setup?key=" + encodeURIComponent(key))).json(); }
  catch (e) { console.log("  Could not reach the server: " + e.message + "\n  Run npm run push:deploy first.\n"); process.exit(1); }
  if (!j.steps) { console.log("  " + (j.error || JSON.stringify(j)) + "\n  If you just ran wa:secret, run npm run push:deploy and try again.\n"); process.exit(1); }
  for (const s of j.steps) console.log(`  ${s.ok ? "OK  " : "FAIL"}  ${s.name}\n        ${s.detail}`);
  console.log(j.ok ? "\n  All good. In the app open Daily Reports > WhatsApp, save the receiver number, then tap Send now to test.\n"
                  : "\n  Something is not right yet — send a screenshot of this (it contains no secrets).\n");
})();
