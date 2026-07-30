import { Page } from "playwright";

export type Platform = "twitter" | "instagram" | "tiktok" | "facebook" | "youtube";

export const PLATFORMS: Platform[] = ["twitter", "instagram", "tiktok", "facebook", "youtube"];

type PlatformDef = {
  home: string;
  /** Returns true/false when confident, null when the page didn't give a clear signal. */
  detectLoggedIn: (page: Page) => Promise<boolean | null>;
};

const has = async (page: Page, selector: string) =>
  (await page.locator(selector).count()) > 0;

/**
 * Login-state heuristics per platform. These check for elements that only exist in one
 * state (account menus vs. login forms). Kept deliberately loose — a null just means
 * "couldn't tell", which surfaces honestly in the dashboard rather than guessing.
 */
export const PLATFORM_DEFS: Record<Platform, PlatformDef> = {
  twitter: {
    home: "https://x.com/home",
    detectLoggedIn: async (page) => {
      if (await has(page, '[data-testid="SideNav_AccountSwitcher_Button"]')) return true;
      // logged out: /home redirects to the x.com landing page with login/signup buttons
      if (page.url().includes("/i/flow/login")) return false;
      if (await has(page, '[data-testid="loginButton"], [data-testid="signupButton"], a[href="/login"]')) return false;
      if (await has(page, '[data-testid="primaryColumn"]')) return true;
      return null;
    },
  },
  instagram: {
    home: "https://www.instagram.com/",
    detectLoggedIn: async (page) => {
      if (await has(page, 'input[name="username"]')) return false;
      if (await has(page, 'svg[aria-label="Home"], a[href*="/direct/"]')) return true;
      return null;
    },
  },
  tiktok: {
    home: "https://www.tiktok.com/",
    detectLoggedIn: async (page) => {
      // Positive evidence first: TikTok flashes a login CTA in the header while pages
      // (search especially) hydrate, even on a signed-in session — the signed-in rail
      // (profile, upload, inbox, messages) is the reliable signal.
      if (await has(page, '[data-e2e="profile-icon"], [data-e2e="nav-profile"], [data-e2e="nav-upload"], [data-e2e="inbox-icon"], [data-e2e="nav-messages"]')) return true;
      if (await has(page, '[data-e2e="top-login-button"]')) return false;
      return null;
    },
  },
  facebook: {
    home: "https://www.facebook.com/",
    detectLoggedIn: async (page) => {
      // A signed-in Facebook never renders a password field or a registration link.
      if (await has(page, 'input[name="pass"], input[type="password"], [data-testid="royal_login_form"], a[href*="/reg/"]')) return false;
      if (await has(page, '[aria-label="Your profile"], [aria-label="Account"], [aria-label="Your profile, "], a[href*="/marketplace/"], [role="navigation"] a[href*="/friends/"]')) return true;
      return null;
    },
  },
  youtube: {
    home: "https://www.youtube.com/",
    detectLoggedIn: async (page) => {
      if (await has(page, "#avatar-btn, ytd-topbar-menu-button-renderer #avatar-btn")) return true;
      if (await has(page, 'a[aria-label="Sign in"], ytd-button-renderer a[href*="accounts.google.com"]')) return false;
      return null;
    },
  },
};
