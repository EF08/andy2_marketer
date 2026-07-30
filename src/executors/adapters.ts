/**
 * Platform adapter registry — the masterplan's "new platform = one adapter file +
 * one registry line". Twitter's flows live inline in the per-type executor files
 * (they predate this registry); every other platform plugs in here.
 */
import { MarketerConfig } from "../config/types";
import type { Action, ActionResult } from "./index";
import { facebookAdapter } from "./facebook";
import { instagramAdapter } from "./instagram";
import { tiktokAdapter } from "./tiktok";
import { youtubeAdapter } from "./youtube";

type Exec = (action: Action, config: MarketerConfig) => Promise<ActionResult>;
export type AdapterSurface = Partial<Record<"post" | "comment" | "like" | "follow" | "dm" | "search" | "scrape", Exec>>;

export const ADAPTERS: Record<string, AdapterSurface> = {
  facebook: facebookAdapter,
  instagram: instagramAdapter,
  tiktok: tiktokAdapter,
  youtube: youtubeAdapter,
};

/** The platform's executor for this action type, or null (twitter's flows are inline). */
export function adapterExec(platform: string | null | undefined, type: keyof AdapterSurface): Exec | null {
  if (!platform) return null;
  return ADAPTERS[platform]?.[type] ?? null;
}

/** Which platforms can run this type — for honest refusal messages. */
export function platformsSupporting(type: keyof AdapterSurface): string[] {
  return ["twitter", ...Object.entries(ADAPTERS).filter(([, a]) => a[type]).map(([p]) => p)];
}
