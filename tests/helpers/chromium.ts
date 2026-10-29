import fs from 'fs';
import { chromium } from 'playwright';

/** Browser tests need Chromium (npx playwright install chromium). Without it they are skipped, not failed. */
export const hasChromium = (() => {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();
