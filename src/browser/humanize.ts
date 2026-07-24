import { Page } from "playwright";
import { Behavior } from "../config/types";

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function randomWait(minMs: number, maxMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, randomInt(minMs, maxMs)));
}

/**
 * Simulates realistic human interaction on a page — small mouse movements and
 * scrolls at varying speeds, like someone reading before they act.
 */
export async function humanizePage(page: Page, behavior: Behavior): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };

  const x1 = randomInt(Math.floor(vp.width * 0.2), Math.floor(vp.width * 0.7));
  const y1 = randomInt(Math.floor(vp.height * 0.15), Math.floor(vp.height * 0.5));
  await page.mouse.move(x1, y1, { steps: randomInt(12, 30) });
  await randomWait(300, 800);

  await page.mouse.wheel(0, randomInt(100, 350));
  await randomWait(400, 1200);

  const x2 = randomInt(Math.floor(vp.width * 0.1), Math.floor(vp.width * 0.8));
  const y2 = randomInt(Math.floor(vp.height * 0.3), Math.floor(vp.height * 0.7));
  await page.mouse.move(x2, y2, { steps: randomInt(8, 20) });
  await randomWait(200, 600);

  await page.mouse.wheel(0, randomInt(50, 250));
  await randomWait(Math.floor(behavior.waitMinMs * 0.3), Math.floor(behavior.waitMinMs * 0.6));
}

/**
 * Types text with human-variable per-keystroke delays.
 *
 * `newline` matters: in X's tweet composer Enter inserts a line break, but in the DM
 * composer Enter SENDS the message — so DM flows must pass "shift+enter" or a multi-line
 * draft would fire off as several half-messages.
 */
export async function humanType(
  page: Page,
  text: string,
  opts: { newline?: "enter" | "shift+enter" } = {},
): Promise<void> {
  const newlineKey = opts.newline === "shift+enter" ? "Shift+Enter" : "Enter";
  for (const ch of text) {
    if (ch === "\r") continue; // CRLF drafts would otherwise double-break
    if (ch === "\n") {
      await page.keyboard.press(newlineKey);
      await randomWait(150, 400);
      continue;
    }
    await page.keyboard.type(ch, { delay: randomInt(40, 160) });
    if (Math.random() < 0.03) await randomWait(300, 900); // occasional "thinking" pause
  }
}
