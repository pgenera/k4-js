'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  // Stamped automatically by .github/workflows/deploy-demo.yml on deploy
  // (and updated in-repo for direct static checkouts).
  const BUILD_INFO = Object.freeze({
    commit: 'pip-sub-smeter',
    builtAt: '2026-11-27T16:48:00Z',
  });

  function formatBuildLabel(info) {
    const b = info || BUILD_INFO;
    const commit = b && b.commit ? String(b.commit).trim() : 'dev';
    const rawTs = b && b.builtAt ? String(b.builtAt).trim() : '';
    let tsLabel = '';
    if (rawTs) {
      const m = rawTs.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      tsLabel = m ? `${m[1]} ${m[2]} UTC` : rawTs;
    }
    return tsLabel ? `${commit} · ${tsLabel}` : commit;
  }

  K4.BUILD_INFO = BUILD_INFO;
  K4.formatBuildLabel = formatBuildLabel;
})();
