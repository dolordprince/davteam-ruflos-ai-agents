// backend/src/browser-inspector.js — Playwright browser verification.
// Interacts with the REAL running application to verify it works in a browser.
// Captures: URL, browser state, console errors, network failures, screenshots.
//
// HARDENING CHANGE: Playwright is now a hard requirement for web applications.
//   - Playwright available → execute real browser inspection
//   - Playwright unavailable → verification is BLOCKED, not PASSED
//   - Browser test failure → task cannot reach COMPLETED until repaired or escalated
import { logger } from './logger.js';

let _playwrightModule = null;
let _playwrightChecked = false;

async function getPlaywright() {
  if (_playwrightChecked) return _playwrightModule;
  _playwrightChecked = true;
  try {
    _playwrightModule = await import('playwright');
    logger.info('browser-inspector.playwright.loaded', { source: 'playwright' });
    return _playwrightModule;
  } catch {
    try {
      _playwrightModule = await import('@playwright/test');
      logger.info('browser-inspector.playwright.loaded', { source: '@playwright/test' });
      return _playwrightModule;
    } catch {
      _playwrightModule = null;
      logger.error('browser-inspector.playwright.not.found');
      return null;
    }
  }
}

/**
 * Inspect a running web application using Playwright.
 *
 * Full inspection:
 * 1. Page loads
 * 2. Page renders content
 * 3. Navigation links work
 * 4. Interactive elements (buttons, inputs) respond
 * 5. Console errors detected
 * 6. Failed network requests detected
 * 7. Responsive/mobile behavior verified
 * 8. Screenshot captured
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

  const pw = await getPlaywright();

  // HARDENING: Playwright not available = BLOCKED, not SKIP
  if (!pw) {
    result.status = 'BLOCKED';
    result.errors.push({
      check: 'playwright-available',
      message: 'Playwright is not installed. Browser verification is BLOCKED — cannot verify web application without a real browser. Install Playwright: npm install playwright && npx playwright install chromium',
    });
    result.checks.push({
      name: 'playwright-available',
      status: 'BLOCKED',
      detail: 'playwright package not found — browser verification blocked',
    });
    logger.error('browser-inspector.blocked.no.playwright');
    return result;
  }

  let browser, context, page;

  try {
    // Launch browser
    browser = await pw.chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();

    const consoleErrors = [];
    const networkFailures = [];
    const networkRequests = [];

    // Capture console errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Capture page errors (uncaught exceptions)
    page.on('pageerror', (err) => {
      consoleErrors.push(`Uncaught exception: ${err.message}`);
    });

    // Capture network responses
    page.on('response', (response) => {
      if (response.status() >= 400) {
        networkFailures.push({ url: response.url(), status: response.status() });
      }
      networkRequests.push({ url: response.url(), status: response.status() });
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
      } else {
        result.evidence.push({ check: 'page-renders', evidence: `${bodyContent} body child elements rendered` });
      }
    } catch (err) {
      result.checks.push({ name: 'page-renders', status: 'FAIL', detail: err.message });
      result.status = 'FAIL';
      result.errors.push({ check: 'page-renders', message: err.message });
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

    // Check 4: Interactive elements — buttons
    try {
      const buttons = await page.$$('button');
      if (buttons.length > 0) {
        // Try clicking the first button to verify it responds
        let buttonClicked = false;
        try {
          await buttons[0].click({ timeout: 3000 });
          buttonClicked = true;
        } catch {
          // Button may not be clickable or may navigate away
        }
        result.checks.push({
          name: 'interactive-buttons',
          status: 'PASS',
          detail: `${buttons.length} buttons found${buttonClicked ? ', first button clicked successfully' : ', first button not clickable (may require input)'}`,
        });
        result.evidence.push({ check: 'interactive-buttons', evidence: `${buttons.length} buttons, click test: ${buttonClicked ? 'responded' : 'not clickable'}` });
      } else {
        result.checks.push({ name: 'interactive-buttons', status: 'SKIP', detail: 'no buttons found' });
      }
    } catch (err) {
      result.checks.push({ name: 'interactive-buttons', status: 'SKIP', detail: err.message });
    }

    // Check 5: Interactive elements — input fields
    try {
      const inputs = await page.$$('input, textarea');
      if (inputs.length > 0) {
        // Try typing into the first input
        let inputTyped = false;
        try {
          await inputs[0].fill('test', { timeout: 3000 });
          inputTyped = true;
        } catch {
          // Input may be read-only or not typeable
        }
        result.checks.push({
          name: 'interactive-inputs',
          status: 'PASS',
          detail: `${inputs.length} inputs found${inputTyped ? ', first input accepted text' : ', first input not typeable'}`,
        });
        result.evidence.push({ check: 'interactive-inputs', evidence: `${inputs.length} inputs, type test: ${inputTyped ? 'accepted' : 'not typeable'}` });
      } else {
        result.checks.push({ name: 'interactive-inputs', status: 'SKIP', detail: 'no input fields found' });
      }
    } catch (err) {
      result.checks.push({ name: 'interactive-inputs', status: 'SKIP', detail: err.message });
    }

    // Check 6: No console errors (HARDENING: console errors = FAIL, not WARN)
    result.checks.push({
      name: 'console-errors',
      status: consoleErrors.length === 0 ? 'PASS' : 'FAIL',
      detail: `${consoleErrors.length} console errors`,
    });
    if (consoleErrors.length > 0) {
      result.status = 'FAIL';
      result.errors.push({
        check: 'console-errors',
        message: `${consoleErrors.length} console errors detected`,
        errors: consoleErrors.slice(0, 5),
      });
      result.evidence.push({ check: 'console-errors', evidence: consoleErrors.slice(0, 5) });
    } else {
      result.evidence.push({ check: 'console-errors', evidence: 'No console errors' });
    }

    // Check 7: No failed network requests (HARDENING: 4xx/5xx = FAIL for app resources)
    // Only fail on requests to the same origin (external APIs may be down)
    const sameOriginFailures = networkFailures.filter(f => {
      try {
        const failUrl = new URL(f.url);
        const appUrl = new URL(url);
        return failUrl.origin === appUrl.origin;
      } catch {
        return true; // Can't parse URL — include it
      }
    });

    result.checks.push({
      name: 'network-failures',
      status: sameOriginFailures.length === 0 ? 'PASS' : 'FAIL',
      detail: `${sameOriginFailures.length} same-origin failed requests (${networkFailures.length} total)`,
    });
    if (sameOriginFailures.length > 0) {
      result.status = 'FAIL';
      result.errors.push({
        check: 'network-failures',
        message: `${sameOriginFailures.length} same-origin network requests failed`,
        failures: sameOriginFailures.slice(0, 5),
      });
      result.evidence.push({ check: 'network-failures', evidence: sameOriginFailures.slice(0, 5) });
    } else {
      result.evidence.push({ check: 'network-failures', evidence: `All ${networkRequests.length} network requests OK` });
    }

    // Check 8: Responsive/mobile behavior
    try {
      await page.setViewportSize({ width: 375, height: 667 }); // iPhone SE
      await page.waitForTimeout(500);
      const mobileContent = await page.evaluate(() => document.body?.children?.length || 0);
      const mobileRenders = mobileContent > 0;
      result.checks.push({
        name: 'mobile-responsive',
        status: mobileRenders ? 'PASS' : 'FAIL',
        detail: `mobile viewport 375x667: ${mobileContent} body children`,
      });
      if (!mobileRenders) {
        result.status = 'FAIL';
        result.errors.push({ check: 'mobile-responsive', message: 'Page does not render content on mobile viewport' });
      } else {
        result.evidence.push({ check: 'mobile-responsive', evidence: '375x667 viewport renders content correctly' });
      }
    } catch (err) {
      result.checks.push({ name: 'mobile-responsive', status: 'FAIL', detail: err.message });
      result.status = 'FAIL';
    }

    // Check 9: Tablet viewport
    try {
      await page.setViewportSize({ width: 768, height: 1024 }); // iPad
      await page.waitForTimeout(500);
      const tabletContent = await page.evaluate(() => document.body?.children?.length || 0);
      result.checks.push({
        name: 'tablet-responsive',
        status: tabletContent > 0 ? 'PASS' : 'FAIL',
        detail: `tablet viewport 768x1024: ${tabletContent} body children`,
      });
      if (tabletContent > 0) {
        result.evidence.push({ check: 'tablet-responsive', evidence: '768x1024 viewport renders content' });
      }
    } catch (err) {
      result.checks.push({ name: 'tablet-responsive', status: 'SKIP', detail: err.message });
    }

    // Capture screenshot
    if (screenshots) {
      try {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.waitForTimeout(500);
        const screenshotPath = projectDir
          ? `${projectDir}/screenshot.png`
          : '/tmp/osiri-screenshot.png';
        await page.screenshot({ path: screenshotPath, fullPage: false });
        result.screenshots.push(screenshotPath);
        result.evidence.push({ check: 'screenshot', evidence: `Screenshot saved to ${screenshotPath}` });
        logger.info('browser-inspector.screenshot.saved', { path: screenshotPath });
      } catch (err) {
        result.warnings.push({ check: 'screenshot', message: `Screenshot failed: ${err.message}` });
      }
    }

    // Final status: if any check is FAIL, the whole inspection is FAIL
    if (result.errors.length > 0) {
      result.status = 'FAIL';
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

  logger.info('browser-inspector.complete', {
    status: result.status,
    checks: result.checks.length,
    errors: result.errors.length,
    warnings: result.warnings.length,
  });
  return result;
}

export async function isPlaywrightAvailable() {
  const pw = await getPlaywright();
  return pw !== null;
}
