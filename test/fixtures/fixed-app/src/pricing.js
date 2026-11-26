// SAMPLE app: the broken fixture with every mistake corrected.
import { initFlags } from './flags.js';

export async function renderPricing(button) {
  const flagsmith = await initFlags();
  const flag = flagsmith.getExperimentFlag('cta_copy');

  if (flag.variant === 'start_free') {
    button.textContent = 'Start free, no card needed';
  } else {
    button.textContent = 'Start trial';
  }

  button.addEventListener('click', () => {
    flagsmith.trackEvent('signup');
  });
}
