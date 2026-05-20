import { test, expect } from '@playwright/test';

test.describe('Authentication Flow & Route Splitting', () => {
  test('Public Marketing Dashboard loads without authentication', async ({ page }) => {
    await page.goto('/?e2e=true');
    
    // Verify the premium marketing view elements
    await expect(page.locator('h1')).toHaveText(/Gauss Aurora/);
    await expect(page.locator('text=Operator Portal')).toBeVisible();
    
    // Ensure Skunkworks elements are explicitly NOT visible on the public page
    await expect(page.locator('text=Logic_Ckt_State')).not.toBeVisible();
  });

  test('Redirects unauthenticated users from /operator to /login', async ({ page }) => {
    await page.goto('/operator?e2e=true');
    
    // Should be intercepted by ProtectedRoute and bounced to /login
    await expect(page).toHaveURL(/.*\/login/);
    
    // Verify the secure gateway UI
    await expect(page.locator('h1')).toHaveText(/Gauss Operator.*Auth Gateway/s);
  });

  test('Authenticates successfully and launches the Mission Control HUD', async ({ page }) => {
    await page.goto('/login?e2e=true');
    
    // Input the seeded operator credentials
    await page.fill('input[type="email"]', 'operator@gauss.space');
    await page.fill('input[type="password"]', 'skunkworks-alpha');
    
    await Promise.all([
      page.waitForURL(/.*\/operator/, { timeout: 15000 }),
      page.click('button[type="submit"]')
    ]);
    
    // Verify Skunkworks specific HUD items are now accessible
    await expect(page.locator('text=Logic_Ckt_State').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Primary_Sensors').first()).toBeVisible({ timeout: 15000 });
  });
});
