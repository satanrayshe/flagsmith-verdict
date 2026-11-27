// SAMPLE app for the Verdict demo: a pricing page that runs the "cta_copy"
// experiment. On this branch four mistakes are planted on purpose so that
// `verdict preflight` (and the CI job) fails. The working version is on main.
import flagsmith from 'https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.5.0/+esm';

const button = document.getElementById('cta');
const status = document.getElementById('status');

async function main() {
  if (!window.FLAGSMITH_ENVIRONMENT_ID || window.FLAGSMITH_ENVIRONMENT_ID.startsWith('YOUR_')) {
    status.textContent = 'Copy config.example.js to config.js and set your client-side environment key.';
    return;
  }
  // Planted mistake 1: enableEvents is missing, so no exposure or event is ever sent.
  await flagsmith.init({
    environmentID: window.FLAGSMITH_ENVIRONMENT_ID,
  });
  // Planted mistake 2: a new random identity on every page load.
  const id = 'visitor-' + Math.random().toString(36).slice(2);
  await flagsmith.identify(id);

  const flag = flagsmith.getExperimentFlag('cta_copy');
  // Planted mistake 3: the variation key is start_free, so this branch never runs.
  if (flag.variant === 'start-free') {
    button.textContent = 'Start free, no card needed';
  } else {
    button.textContent = 'Start trial';
  }
  button.disabled = false;
  status.textContent = `identity: ${id}\nvariation: ${flag.variant ?? 'control'}`;

  button.addEventListener('click', () => {
    // Planted mistake 4: the metric listens for "signup". Event names are case-sensitive.
    flagsmith.trackEvent('Signup');
    status.textContent += '\nsent event: Signup';
  });
}

main().catch((err) => { status.textContent = `Could not load flags: ${err.message}`; });
