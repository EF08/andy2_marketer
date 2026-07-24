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
      if (await has(page, '[data-e2e="top-login-button"]')) return false;
      if (await has(page, '[data-e2e="profile-icon"], [data-e2e="nav-profile"]')) return true;
      return null;
    },
  },
  facebook: {
    home: "https://www.facebook.com/",
    detectLoggedIn: async (page) => {
      if (await has(page, 'form[action*="login"] input[name="email"], input[data-testid="royal_email"]')) return false;
      if (await has(page, '[aria-label="Your profile"], [aria-label="Account"]')) return true;
      return null;
    },
  },
  youtube: {
    home: "https://www.youtube.com/",
    detectLoggedIn: async (page) => {
      if (await has(page, "#avatar-btn")) return true;
      if (await has(page, 'a[aria-label="Sign in"], ytd-button-renderer a[href*="accounts.google.com"]')) return false;
      return null;
    },
  },
};
