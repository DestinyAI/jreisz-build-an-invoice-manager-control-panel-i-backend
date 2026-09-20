const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const page = await browser.newPage();

  console.log('Navigating to calendar...');
  await page.goto('https://id.svitla.com/users/2900/calendar');

  // Click "Login with Microsoft"
  await page.click('a[href="/auth/saml"]');
  await page.waitForURL(/microsoft|login\.microsoftonline/);
  console.log('On Microsoft login page:', page.url());

  // Enter email
  await page.fill('input[type="email"]', 'j.reisz@svitla.com');
  await page.click('input[type="submit"]');
  await page.waitForTimeout(1500);

  // Enter password
  await page.fill('input[type="password"]', process.env.SVITLA_PASS);
  await page.click('input[type="submit"]');
  await page.waitForTimeout(2000);

  // Handle "Stay signed in?" prompt if it appears
  const staySignedIn = page.locator('input[type="submit"][value="Yes"]');
  if (await staySignedIn.isVisible()) {
    await staySignedIn.click();
  }

  // Wait for redirect back to svitla.com (may land on /info)
  await page.waitForURL(/svitla\.com/, { timeout: 20000 });
  console.log('Redirected to:', page.url());

  // Navigate explicitly to the calendar
  await page.goto('https://id.svitla.com/users/2900/calendar');
  await page.waitForLoadState('networkidle');
  console.log('On calendar:', page.url());

  // Dump the page HTML structure for inspection
  const html = await page.content();
  const fs = require('fs');
  fs.writeFileSync('/tmp/calendar-dump.html', html);
  console.log('HTML saved to /tmp/calendar-dump.html');

  await page.waitForTimeout(3000);
  await browser.close();
})();
