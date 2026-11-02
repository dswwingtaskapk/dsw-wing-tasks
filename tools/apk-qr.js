// npm run apk  -> waits for GitHub to finish building the APK of your last push, then shows a QR code.
// npm run qr   -> shows the QR code of the newest APK right away.
const { execSync } = require("child_process");
const qrcode = require("qrcode-terminal");

const NOW = process.argv.includes("--now");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = c => { try { return execSync(c, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch (e) { return ""; } };

function repoName() {
  const u = sh("git remote get-url origin");
  const m = u.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : "";
}
async function gh(path) {
  const r = await fetch("https://api.github.com" + path, { headers: { "User-Agent": "wing-tasks-apk", Accept: "application/vnd.github+json" } });
  if (r.status === 404) return { notFound: true };
  if (r.status === 403) return { limited: true };
  return r.json();
}
function show(url, title) {
  console.log("\n  " + title + "\n");
  qrcode.generate(url, { small: true }, q => console.log(q.split("\n").map(l => "  " + l).join("\n")));
  console.log("\n  Scan with the phone camera, download, then tap Install.");
  console.log("  Link: " + url + "\n");
}

(async () => {
  const repo = repoName();
  if (!repo) { console.log("\n  This folder is not connected to GitHub yet (git remote add origin ...).\n"); process.exit(1); }
  const latestUrl = `https://github.com/${repo}/releases/latest/download/WingTasks.apk`;

  if (NOW) {
    const rel = await gh(`/repos/${repo}/releases/latest`);
    if (rel.notFound) { console.log("\n  No APK yet, or the GitHub repository is Private. Make it Public (Settings > General > Danger Zone) and push once.\n"); process.exit(1); }
    show(latestUrl, `Newest APK: Wing Tasks ${String(rel.tag_name || "").replace(/^v/, "")}`);
    return;
  }

  const sha = sh("git rev-parse HEAD");
  const local = sh("git status --porcelain");
  if (local) console.log("\n  Note: you have changes that are not committed yet. Run git add . / git commit / git push first if you want them in the APK.");
  const ahead = sh("git rev-list --count @{u}..HEAD");
  if (ahead && ahead !== "0") console.log("  Note: your last commit is not pushed yet. Run: git push");

  console.log(`\n  Waiting for GitHub to build the APK for your last commit (${sha.slice(0, 7)})...`);
  const t0 = Date.now(); let seen = false, lastMsg = "";
  while (Date.now() - t0 < 15 * 60000) {
    const j = await gh(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=5`);
    if (j.notFound) { console.log("\n  GitHub repository not found or it is Private. Make it Public so phones can download the APK.\n"); process.exit(1); }
    if (j.limited) { console.log("  GitHub says: too many checks. Waiting a minute..."); await sleep(60000); continue; }
    const run = (j.workflow_runs || []).find(r => /APK/i.test(r.name || "")) || (j.workflow_runs || [])[0];
    if (!run) {
      if (Date.now() - t0 > 90000 && !seen) {
        console.log("\n  No new APK build started for this commit (only server/rules/tool files changed, or it is not pushed).");
        show(latestUrl, "So here is the newest APK that already exists:");
        return;
      }
    } else {
      seen = true;
      const mins = Math.floor((Date.now() - t0) / 60000), secs = Math.floor((Date.now() - t0) / 1000) % 60;
      const msg = `  Build ${run.run_number}: ${run.status.replace("_", " ")}  (${mins}m ${secs}s)`;
      if (msg !== lastMsg) { process.stdout.write("\r" + msg + "      "); lastMsg = msg; }
      if (run.status === "completed") {
        console.log("");
        if (run.conclusion !== "success") {
          console.log(`\n  The build FAILED. Open this page and look at the red step:\n  ${run.html_url}\n`);
          process.exit(1);
        }
        await sleep(3000);
        show(`https://github.com/${repo}/releases/download/v1.${run.run_number}/WingTasks.apk`, `APK ready: Wing Tasks 1.${run.run_number}`);
        return;
      }
    }
    await sleep(15000);
  }
  console.log(`\n  Still not finished after 15 minutes. Check: https://github.com/${repo}/actions\n`);
})().catch(e => { console.log("\n  Could not reach GitHub: " + e.message + "\n"); process.exit(1); });
