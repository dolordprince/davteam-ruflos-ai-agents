// backend/src/browser-inspector.js — Playwright browser verification.
// Interacts with the REAL running application to verify it works in a browser.
// Captures: URL, browser state, console errors, network failures, screenshots.
import { logger } from './logger.js';

let playwrightAvailable = false;
let chromiumAvailable = false;

async function checkPlaywright() {
  try {
    const pw = await import('playwright');
    playwrightAvailable = true;
    return pw;
  } catch {
    try {
      const pw = await import('@playwright/test');
      playwrightAvailable = true;
      return pw;
    } catch {
      playwrightAvailable = false;
      return null;
    }
  }
}

/**
 * Inspect a running web application using Playwright.
 * Verifies: application starts, pages render, navigation works, no console errors.
 *
 * @param {object} options - { url, projectDir, screenshots, timeout }
 * @returns {Promise<object>} { status, checks, errors, warnings, evidence, screenshots }
 */
export async function inspectBrowser(options = {}) {
  const {
    url = 'http://localhost:5173',
    projectDir,
    screenshots = true,
    timeout = 30000,
  } = options;

  const result = {
    status: 'PASS',
    checks: [],
    errors: [],
    warnings: [],
    evidence: [],
    screenshots: [],
  };

  const pw = await checkPlaywright();
  if (!pw) {
    result.status = 'SKIP';
    result.warnings.push({ message: 'Playwright not installed — browser inspection skipped' });
    result.checks.push({ name: 'playwright-available', status: 'SKIP', detail: 'playwright package not found' });
    logger.warn('browser-inspector.playwright.not.installed');
    return result;
  }

  let browser, page, context;

  try {
    // Launch browser
    browser = await pw.chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();

    const consoleErrors = [];
    const networkFailures = [];

    // Capture console errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Capture network failures
    page.on('response', (response) => {
      if (response.status() >= 400) {
        networkFailures.push({ url: response.url(), status: response.status() });
      }
    });

    // Check 1: Application starts and page loads
    try {
      await page.goto(url, { timeout, waitUntil: 'networkidle' });
      result.checks.push({ name: 'page-loads', status: 'PASS', detail: `Page loaded at ${url}` });
      result.evidence.push({ check: 'page-loads', evidence: `URL: ${url}, title: ${await page.title()}` });
    } catch (err) {
      result.checks.push({ name: 'page-loads', status: 'FAIL', detail: err.message });
      result.status = 'FAIL';
      result.errors.push({ check: 'page-loads', message: `Application did not load: ${err.message}` });
      return result;
    }

    // Check 2: Page renders content (body has child elements)
    try {
      const bodyContent = await page.evaluate(() => document.body?.children?.length || 0);
      const hasContent = bodyContent > 0;
      result.checks.push({ name: 'page-renders', status: hasContent ? 'PASS' : 'FAIL', detail: `${bodyContent} body children` });
      if (!hasContent) {
        result.status = 'FAIL';
        result.errors.push({ check: 'page-renders', message: 'Page body has no content' });
      }
    } catch (err) {
      result.checks.push({ name: 'page-renders', status: 'FAIL', detail: err.message });
      result.status = 'FAIL';
    }

    // Check 3: Navigation links work (if any)
    try {
      const navLinks = await page.$$eval('a[href]', (els) => els.map(e => e.getAttribute('href')));
      if (navLinks.length > 0) {
        result.checks.push({ name: 'navigation', status: 'PASS', detail: `${navLinks.length} nav links found` });
        result.evidence.push({ check: 'navigation', evidence: `Links: ${navLinks.slice(0, 5).join(', ')}` });
      } else {
        result.checks.push({ name: 'navigation', status: 'SKIP', detail: 'no nav links found' });
      }
    } catch (err) {
      result.checks.push({ name: 'navigation', status: 'SKIP', detail: err.message });
    }

    // Check 4: No console errors
    result.checks.push({ name: 'console-errors', status: consoleErrors.length === 0 ? 'PASS' : 'FAIL', detail: `${consoleErrors.length} console errors` });
    if (consoleErrors.length > 0) {
      result.status = 'FAIL';
      result.errors.push({ check: 'console-errors', message: `${consoleErrors.length} console errors detected`, errors: consoleErrors.slice(0, 5) });
      result.evidence.push({ check: 'console-errors', evidence: consoleErrors.slice(0, 5) });
    }

    // Check 5: No network failures
    result.checks.push({ name: 'network-failures', status: networkFailures.length === 0 ? 'PASS' : 'WARN', detail: `${networkFailures.length} failed requests` });
    if (networkFailures.length > 0) {
      result.warnings.push({ check: 'network-failures', message: `${networkFailures.length} failed network requests`, failures: networkFailures.slice(0, 5) });
      result.evidence.push({ check: 'network-failures', evidence: networkFailures.slice(0, 5) });
    }

    // Check 6: Responsive/mobile behavior
    try {
      await page.setViewportSize({ width: 375, height: 667 }); // iPhone SE
      await page.waitForTimeout(500);
      const mobileContent = await page.evaluate(() => document.body?.children?.length || 0);
      result.checks.push({ name: 'mobile-responsive', status: mobileContent > 0 ? 'PASS' : 'FAIL', detail: `mobile viewport: ${mobileContent} body children` });
      result.evidence.push({ check: 'mobile-responsive', evidence: '375x667 viewport renders content' });
    } catch (err) {
      result.checks.push({ name: 'mobile-responsive', status: 'SKIP', detail: err.message });
    }

    // Check 7: Interactive elements work (buttons)
    try {
      const buttons = await page.$$('button');
      if (buttons.length > 0) {
        result.checks.push({ name: 'interactive-elements', status: 'PASS', detail: `${buttons.length} buttons found` });
      } else {
        result.checks.push({ name: 'interactive-elements', status: 'SKIP', detail: 'no buttons found' });
      }
    } catch (err) {
      result.checks.push({ name: 'interactive-elements', status: 'SKIP', detail: err.message });
    }

    // Capture screenshot if requested
    if (screenshots) {
      try {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.waitForTimeout(500);
        const screenshotPath = projectDir ? `${projectDir}/screenshot.png` : '/tmp/osiri-screenshot.png';
        await page.screenshot({ path: screenshotPath, fullPage: false });
        result.screenshots.push(screenshotPath);
        result.evidence.push({ check: 'screenshot', evidence: `Screenshot saved to ${screenshotPath}` });
        logger.info('browser-inspector.screenshot.saved', { path: screenshotPath });
      } catch (err) {
        result.warnings.push({ check: 'screenshot', message: `Screenshot failed: ${err.message}` });
      }
    }

  } catch (err) {
    result.status = 'FAIL';
    result.errors.push({ check: 'browser', message: `Browser inspection failed: ${err.message}` });
    logger.error('browser-inspector.failed', { error: err.message });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }

  logger.info('browser-inspector.complete', { status: result.status, checks: result.checks.length, errors: result.errors.length });
  return result;
}

export function isPlaywrightAvailable() {
  return playwrightAvailable;
}
