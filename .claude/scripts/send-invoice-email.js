const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SVITLA_PASS = process.env.SVITLA_PASS;
const SVITLA_EMAIL = 'j.reisz@svitla.com';

function getInvoicePath() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const backendRoot = path.resolve(__dirname, '../..');
  return path.join(backendRoot, 'invoices', `Invoice ${month}_${year}.pdf`);
}

(async () => {
  if (!SVITLA_PASS) { console.error('Set SVITLA_PASS env var'); process.exit(1); }

  const invoicePath = getInvoicePath();
  if (!fs.existsSync(invoicePath)) {
    console.error(`Invoice not found: ${invoicePath}`);
    process.exit(1);
  }
  console.log(`Attaching: ${invoicePath}`);

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const composeUrl = `https://outlook.office.com/mail/deeplink/compose?to=ca.guerrero%40svitla.com&subject=Invoice%20Juan%20Reisz%20-%20Glassdoor&body=Buenas%20tardes%20Carlos%2C%0AAdjunto%20factura%20correspondiente%20al%20mes%20en%20curso.%0A%0ASaludos%21`;

  const browser = await chromium.launch({ headless: false, slowMo: 400 });
  const page = await browser.newPage();

  // Login
  await page.goto('https://outlook.office.com');
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.fill('input[type="email"]', SVITLA_EMAIL);
  await page.click('input[type="submit"]');
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await page.fill('input[type="password"]', SVITLA_PASS);
  await page.click('input[type="submit"]');
  await page.waitForSelector('text=Stay signed in', { timeout: 10000 });
  await page.click('text=Yes');
  await page.waitForURL(/outlook\.office\.com/, { timeout: 30000 });
  await page.waitForLoadState('networkidle');
  console.log('Logged in');

  // Open compose
  await page.goto(composeUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('[aria-label="Attach file"]', { timeout: 20000 });
  console.log('Compose ready');

  // Attach file via dropdown → Browse this computer
  await page.click('[aria-label="Attach file"]');
  await page.waitForTimeout(1000);
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    page.click('text=Browse this computer'),
  ]);
  await fc.setFiles(invoicePath);
  console.log('File attached');

  // Wait for upload then send
  await page.waitForTimeout(4000);
  await page.click('[aria-label="Send"]');
  await page.waitForTimeout(3000);

  console.log(`\n✓ Email sent to ca.guerrero@svitla.com with Invoice ${month}_${year}.pdf`);
  await browser.close();
})();
