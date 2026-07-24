import fs from "node:fs";
import path from "node:path";

/** Finds the real Google Chrome binary. Cross-platform: macOS now, Windows for the PC later. */
export function detectChromeExecutable(explicitPath?: string): string {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      throw new Error(`[chrome] chromeExecutablePath does not exist: ${explicitPath}`);
    }
    return explicitPath;
  }

  let candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(process.env.HOME ?? "", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
  } else if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA;
    candidates = [
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      ...(localAppData ? [path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")] : []),
    ];
  } else {
    candidates = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`[chrome] Could not find Chrome on ${process.platform}. Set chrome.chromeExecutablePath in config.`);
}
