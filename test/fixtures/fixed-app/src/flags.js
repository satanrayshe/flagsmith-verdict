// SAMPLE app: the broken fixture with every mistake corrected.
import flagsmith from '@flagsmith/flagsmith';

const ID_KEY = 'sample_anonymous_id';

function anonymousId() {
  let id = localStorage.getItem(ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(ID_KEY, id);
  }
  return id;
}

export async function initFlags() {
  await flagsmith.init({
    environmentID: window.FLAGSMITH_ENVIRONMENT_ID,
    enableEvents: true,
  });
  await flagsmith.identify(anonymousId());
  window.addEventListener('pagehide', () => flagsmith.flushEvents());
  return flagsmith;
}
