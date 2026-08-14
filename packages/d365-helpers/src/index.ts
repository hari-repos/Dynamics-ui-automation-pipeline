/**
 * @dynamics/d365-helpers
 * Shared helper utilities for Dynamics 365 UI automation.
 */

export function getEnvironmentConfig() {
  return {
    url: process.env.DYNAMICS_URL,
    apiUrl: process.env.DYNAMICS_API_URL,
    browser: process.env.BROWSER_NAME || 'chromium',
  };
}

export function logAutomationContext(scenarioName: string) {
  console.log(`[D365 Automation] Scenario: "${scenarioName}" | App: ${process.env.DYNAMICS_URL}`);
}
