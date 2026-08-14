import { createBaseConfig } from '../../playwright.config.base';
import { defineBddConfig }  from 'playwright-bdd';

const bddConfig = defineBddConfig({
  features: 'tests/features/**/*.feature',
  steps:    'tests/steps/**/*.ts',
});

export default createBaseConfig(bddConfig);
