import { test, expect } from '@playwright/test';
import { mockUiApis } from './helpers/mockUiApis';

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
    // Operators land on /operator; without a role the guard treats this as a user.
    role: 'operator',
  },
};

test.describe('Authentication Flow & Route Splitting', () => {
  test('Public Marketing Dashboard loads without authentication', async ({ page }) => {
    await mockUiApis(page, { auth: false });
    await page.goto('/?e2e=true');
    
    // Public landing: brand header, operator entry point, fail-closed feed state
    await expect(page.locator('h1')).toHaveText(/Gauss Aurora/);
    await expect(page.getByRole('link', { name: /operator portal/i })).toBeVisible();

    // Operator console panels are explicitly NOT on the public page
    await expect(page.getByText('Feed source')).not.toBeVisible();
  });

  test('Redirects unauthenticated users from /operator to /login', async ({ page }) => {
    const authenticated = false;

    await mockUiApis(page, { auth: false });

    await page.route('**/get-session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ session: authenticated ? AUTH_SESSION.session : null, user: authenticated ? AUTH_SESSION.user : null }),
      });
    });

    await page.route('**/api/auth/get-session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ session: authenticated ? AUTH_SESSION.session : null, user: authenticated ? AUTH_SESSION.user : null }),
      });
    });

    await page.goto('/operator?e2e=true');
    
    // Should be intercepted by ProtectedRoute and bounced to /login
    await expect(page).toHaveURL(/.*\/login/);
    
    // Verify the sign-in page
    await expect(page.locator('h1')).toHaveText(/Sign in to Gauss/);
  });

  test('Authenticates successfully and launches the Mission Control HUD', async ({ page }) => {
    let authenticated = false;

    await mockUiApis(page, { auth: false });

    await page.route('**/get-session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ session: authenticated ? AUTH_SESSION.session : null, user: authenticated ? AUTH_SESSION.user : null }),
      });
    });

    await page.route('**/sign-in/email', async (route) => {
      authenticated = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(AUTH_SESSION),
      });
    });

    await page.route('**/api/auth/sign-in/email', async (route) => {
      authenticated = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(AUTH_SESSION),
      });
    });

    await page.goto('/login?e2e=true');
    
    // Input the seeded operator credentials
    await page.fill('input[type="email"]', 'operator@gauss.space');
    await page.fill('input[type="password"]', 'skunkworks-alpha');
    
    await Promise.all([
      page.waitForURL(/.*\/operator/, { timeout: 15000 }),
      page.click('button[type="submit"]')
    ]);
    
    // Operator console panels are now accessible
    await expect(page.getByRole('heading', { name: /solar_wind/i })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Feed source')).toBeVisible({ timeout: 15000 });
  });
});
