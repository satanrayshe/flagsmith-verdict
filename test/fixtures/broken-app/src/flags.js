// SAMPLE app. The mistakes in this folder are planted on purpose.
import flagsmith from '@flagsmith/flagsmith';

export async function initFlags() {
  // Planted mistake 1: enableEvents is missing, so no exposure or event is ever sent.
  await flagsmith.init({
    environmentID: window.FLAGSMITH_ENVIRONMENT_ID,
  });
  // Planted mistake 2: a new random identity on every page load.
  await flagsmith.identify('visitor-' + Math.random().toString(36).slice(2));
  return flagsmith;
}
