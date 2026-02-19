// Anti-detection: hide Playwright/automation markers
Object.defineProperty(navigator, 'webdriver', { get: () => false });

// Fake plugins (headless Chromium has 0 plugins)
Object.defineProperty(navigator, 'plugins', {
  get: () => [1, 2, 3, 4, 5],
});

// Chinese locale
Object.defineProperty(navigator, 'languages', {
  get: () => ['zh-CN', 'zh', 'en'],
});

// Override permissions query (Playwright fingerprint)
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) =>
  parameters.name === 'notifications'
    ? Promise.resolve({ state: Notification.permission })
    : originalQuery(parameters);

// Remove Playwright-specific window properties
delete window.__playwright;
delete window.__pw_manual;
