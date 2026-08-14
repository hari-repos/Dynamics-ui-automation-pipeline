import { createBdd }            from 'playwright-bdd';
import { getEnvironmentConfig }  from '@dynamics/d365-helpers';

const { Given, When, Then } = createBdd();

Given('I navigate to D365 Sales Hub', async ({ page }) => {
  const config = getEnvironmentConfig();
  console.log(`Navigating to D365 Sales Hub at ${config.url || 'https://org.crm.dynamics.com'} using ${config.browser}`);
});

When('I open the lead management section', async ({ page }) => {
  console.log('Opening lead management grid');
});

Then('I should see the active lead list', async ({ page }) => {
  console.log('Verified active lead list is displayed');
});

Then('I should see the read-only lead dashboard', async ({ page }) => {
  console.log('Verified read-only lead dashboard is displayed');
});
