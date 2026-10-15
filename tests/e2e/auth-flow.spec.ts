import { test, expect } from '@playwright/test';
import { fulfillCorsJson, mockUiApis } from './helpers/mockUiApis';

const AUTH_SESSION = {
  session: {
    id: 'sess-op-0001',
    userId: 'user-op-0001',
    token: 'mock-session-token',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    ipAddress: null,
    userAgent: null,
  },
  user: {
    id: 'user-op-0001',
    email: 'operator@gauss.space',
    emailVerified: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: 'Operator Gauss',
    image: null,
    role: 'operator',
  },
};

test.describe('Authentication Flow & Route Splitting', () => {
  test('Public Marketing Dashboard loads without authentication', async ({ page }) => {
    await mockUiApis(page, { auth: false });
    await page.goto('/?e2e=true');
    
    // Verify the premium marketing view elements
    await expect(page.locator('h1')).toHaveText(/Gauss Aurora/);
    await expect(page.locator('text=Operator Portal')).toBeVisible();
    
    // The operator console is not part of the public page
    await expect(page.getByText('00_OPERATOR')).not.toBeVisible();
  });

  test('Redirects unauthenticated users from /operator to /login', async ({ page }) => {
    const authenticated = false;

    await mockUiApis(page, { auth: false });

    await page.route('**/get-session', async (route) => {
      await fulfillCorsJson(route, { session: authenticated ? AUTH_SESSION.session : null, user: authenticated ? AUTH_SESSION.user : null });
    });

    await page.route('**/api/auth/get-session', async (route) => {
      await fulfillCorsJson(route, { session: authenticated ? AUTH_SESSION.session : null, user: authenticated ? AUTH_SESSION.user : null });
    });

    await page.goto('/operator?e2e=true');
    
    // Should be intercepted by ProtectedRoute and bounced to /login
    await expect(page).toHaveURL(/.*\/login/);
    
    // The sign-in page
    await expect(page.locator('h1')).toHaveText(/Sign in to Gauss/);
  });

  test('Authenticates successfully and launches the Mission Control HUD', async ({ page }) => {
    let authenticated = false;

    await mockUiApis(page, { auth: false });

    await page.route('**/get-session', async (route) => {
      await fulfillCorsJson(route, { session: authenticated ? AUTH_SESSION.session : null, user: authenticated ? AUTH_SESSION.user : null });
    });

    await page.route('**/sign-in/email', async (route) => {
      authenticated = true;
      await fulfillCorsJson(route, AUTH_SESSION);
    });

    await page.route('**/api/auth/sign-in/email', async (route) => {
      authenticated = true;
      await fulfillCorsJson(route, AUTH_SESSION);
    });

    await page.goto('/login?e2e=true');
    
    // Input the seeded operator credentials
    await page.fill('input[type="email"]', 'operator@gauss.space');
    await page.fill('input[type="password"]', 'skunkworks-alpha');
    
    await Promise.all([
      page.waitForURL(/.*\/operator/, { timeout: 15000 }),
      page.click('button[type="submit"]')
    ]);
    
    // The operator console is now accessible
    await expect(page.getByRole('heading', { name: /00_OPERATOR/ })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('02_SOLAR_WIND')).toBeVisible({ timeout: 15000 });
  });
});
