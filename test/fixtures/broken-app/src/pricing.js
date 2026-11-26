// SAMPLE app. The mistakes in this folder are planted on purpose.
import { initFlags } from './flags.js';

export async function renderPricing(button) {
  const flagsmith = await initFlags();
  const flag = flagsmith.getExperimentFlag('cta_copy');

  // Planted mistake 3: the variation key is start_free, so this branch never runs.
  if (flag.variant === 'start-free') {
    button.textContent = 'Start free, no card needed';
  } else {
    button.textContent = 'Start trial';
  }

  button.addEventListener('click', () => {
    // Planted mistake 4: the metric listens for "signup". Event names are case-sensitive.
    flagsmith.trackEvent('Signup');
  });
}
