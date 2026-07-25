import fs from "node:fs";
import path from "node:path";

/**
 * Chrome marks the profile "Crashed" while running and only rewrites it to
 * "Normal" after a clean shutdown — and once a session dies badly, the flag is
 * sticky: Chrome keeps writing "Crashed" until a user acknowledges the
 * crash-restore bubble, which never happens in an automated session. One hard
 * kill would otherwise poison the profile into showing "Chrome didn't shut down
 * correctly / Restore pages?" on every launch forever. Reset it before launching.
 *
 * Ported from andy2_crawler, which hit this first.
 */
export function clearCrashExitFlags(userDataDir: string, profileDirectory: string): void {
  const prefsPath = path.join(userDataDir, profileDirectory, "Preferences");
  if (!fs.existsSync(prefsPath)) return;
  try {
    const obj = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    if (!obj.profile) obj.profile = {};
    if (obj.profile.exit_type !== "Normal" || obj.profile.exited_cleanly !== true) {
      obj.profile.exit_type = "Normal";
      obj.profile.exited_cleanly = true;
      fs.writeFileSync(prefsPath, JSON.stringify(obj));
      console.log("[session] Cleared stale crash flag in Preferences (exit_type -> Normal)");
    }
  } catch (err) {
    console.warn("[session] Could not clear crash flag in Preferences:", (err as Error).message);
  }
}
