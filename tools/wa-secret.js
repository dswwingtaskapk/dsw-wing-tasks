// Saves the Green-API (WhatsApp) details on the push server. Usage: npm run wa:secret
const fs = require("fs"), path = require("path"), crypto = require("crypto"), readline = require("readline"), { spawn } = require("child_process");
const root = path.join(__dirname, "..");
const verifyFile = path.join(__dirname, ".wa-verify.txt");
const bin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, a => r(String(a || "").trim())));
function put(name, value) {
  return new Promise((res, rej) => {
    const p = spawn(bin, ["secret", "put", name, "-c", "push-worker/wrangler.toml"], { cwd: root, stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32",
      env: { ...process.env, NODE_OPTIONS: "--dns-result-order=ipv4first" } });
    p.stdin.write(value); p.stdin.end();
    p.on("exit", c => c === 0 ? res() : rej(new Error(name + " could not be saved")));
  });
}
(async () => {
  console.log("\n  WhatsApp (Green-API) — copy each value from console.green-api.com and paste it here.");
  console.log("  (Right-click pastes in the VS Code terminal. Then press Enter.)\n");
  let url = await ask("  1) apiUrl            (looks like https://7105.api.greenapi.com): ");
  const id = await ask("  2) idInstance        (only digits): ");
  const token = await ask("  3) apiTokenInstance  (long letters and numbers): ");
  rl.close();
  url = url.replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) { console.log("\n  apiUrl must look like https://1234.api.greenapi.com — nothing was saved.\n"); process.exit(1); }
  if (!/^\d{6,}$/.test(id)) { console.log("\n  idInstance must be digits only — nothing was saved.\n"); process.exit(1); }
  if (!/^[a-z0-9]{20,}$/i.test(token)) { console.log("\n  apiTokenInstance looks wrong (copy the whole thing) — nothing was saved.\n"); process.exit(1); }
  let verify = fs.existsSync(verifyFile) ? fs.readFileSync(verifyFile, "utf8").trim() : "";
  if (!verify) { verify = "wing" + crypto.randomBytes(12).toString("hex"); fs.writeFileSync(verifyFile, verify); }
  try {
    console.log("\n  Saving on the server (4 items)...\n");
    await put("GREEN_URL", url); await put("GREEN_ID", id); await put("GREEN_TOKEN", token); await put("WA_VERIFY", verify);
  } catch (e) { console.log("\n  " + e.message + ". Run npm run push:login, then try again.\n"); process.exit(1); }
  console.log("\n  Saved. Now run:  npm run wa:setup\n");
})();
