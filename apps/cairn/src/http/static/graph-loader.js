// Cytoscape and the layout engines are only needed once a project graph opens,
// so they are injected on demand instead of blocking the project list.
(function () {
  const CORE_SRC = '/static/vendor/cytoscape.min.js';
  const ENGINES = {
    dagre: ['/static/vendor/dagre.min.js', '/static/vendor/cytoscape-dagre.js'],
    klay: ['/static/vendor/klay.js', '/static/vendor/cytoscape-klay.js'],
    elk: ['/static/vendor/elk.bundled.js', '/static/vendor/cytoscape-elk.js'],
  };
  const loading = new Map();

  function inject(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(src));
      document.head.appendChild(script);
    });
  }

  function load(key, sources) {
    let pending = loading.get(key);
    if (!pending) {
      // The extensions register themselves on the global cytoscape, so each
      // script in a chain must finish before the next one starts.
      pending = sources.reduce(
        (chain, src) => chain.then(() => inject(src)),
        Promise.resolve(),
      );
      pending.catch(() => loading.delete(key));
      loading.set(key, pending);
    }
    return pending;
  }

  window.graphLoader = {
    async ensure(engine) {
      await load('core', [CORE_SRC]);
      const sources = ENGINES[engine];
      if (!sources) throw new Error(`unknown layout engine ${engine}`);
      await load(engine, sources);
      return window.cytoscape;
    },
    isLoaded(engine) {
      return loading.has('core') && (engine === undefined || loading.has(engine));
    },
  };
})();
