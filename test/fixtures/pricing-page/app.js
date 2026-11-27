// SAMPLE app for the Verdict demo: a pricing page that runs the "cta_copy"
// experiment. It passes `verdict preflight`.
import flagsmith from 'https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.5.0/+esm';

const ID_KEY = 'sample_anonymous_id';
const button = document.getElementById('cta');
const status = document.getElementById('status');

// A persistent anonymous id, so the same visitor stays in the same variation.
function anonymousId() {
  let id = localStorage.getItem(ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(ID_KEY, id);
  }
  return id;
}

async function main() {
  if (!window.FLAGSMITH_ENVIRONMENT_ID || window.FLAGSMITH_ENVIRONMENT_ID.startsWith('YOUR_')) {
    status.textContent = 'Copy config.example.js to config.js and set your client-side environment key.';
    return;
  }
  await flagsmith.init({
    environmentID: window.FLAGSMITH_ENVIRONMENT_ID,
    enableEvents: true,
  });
  const id = anonymousId();
  await flagsmith.identify(id);

  // Evaluates the flag and records the exposure in one call.
  const flag = flagsmith.getExperimentFlag('cta_copy');
  if (flag.variant === 'start_free') {
    button.textContent = 'Start free, no card needed';
  } else {
    button.textContent = 'Start trial';
  }
  button.disabled = false;
  status.textContent = `identity: ${id}\nvariation: ${flag.variant ?? 'control'}\nin experiment: ${flag.experiment?.inExperiment ?? false}`;

  button.addEventListener('click', async () => {
    flagsmith.trackEvent('signup');
    await flagsmith.flushEvents();
    status.textContent += '\nsent event: signup';
  });
  window.addEventListener('pagehide', () => flagsmith.flushEvents());
}

main().catch((err) => { status.textContent = `Could not load flags: ${err.message}`; });
