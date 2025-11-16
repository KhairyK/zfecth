(function (global) {
  "use strict";

  // -------------------------
  // Utilities
  // -------------------------
  const isObj = v => v && typeof v === "object" && !Array.isArray(v);
  const safeJson = async res => {
    try { return await res.json(); } catch { return null; }
  };

  // -------------------------
  // Env chaining helper
  // -------------------------
  function createEnvChain() {
    const ctx = { dev: null, prod: null, staging: null, other: {} };

    const api = {
      dev(url) { ctx.dev = String(url); return api; },
      prod(url) { ctx.prod = String(url); return api; },
      staging(url) { ctx.staging = String(url); return api; },
      otherEnv(name, url) { if (typeof name === "string") ctx.other[name] = String(url); return api; },

      /**
       * resolve(hostname)
       * - If no hostname provided, attempts to use `location.hostname` in browsers; otherwise empty string.
       * - Rules:
       *    - localhost / 127.x.x.x / 0.0.0.0 => dev (fallback to prod if dev not set)
       *    - hostname contains 'staging' => staging fallback chain
       *    - otherwise => prod fallback to dev
       */
      resolve(hostname) {
        let h = "";
        if (typeof hostname === "string" && hostname.length) {
          h = hostname.toLowerCase();
        } else if (typeof location !== "undefined" && location && location.hostname) {
          h = (location.hostname || "").toLowerCase();
        } else if (typeof global !== "undefined" && global && global.process && global.process.env && global.process.env.HOSTNAME) {
          h = String(global.process.env.HOSTNAME).toLowerCase();
        }

        // localhost-like
        if (h.includes("localhost") || h.startsWith("127.") || h === "0.0.0.0") {
          return ctx.dev || ctx.prod || ctx.staging || "";
        }
        if (h.includes("staging")) {
          return ctx.staging || ctx.prod || ctx.dev || "";
        }
        return ctx.prod || ctx.dev || ctx.staging || "";
      },

      toString() { return api.resolve(); },
      _ctx: ctx
    };

    return api;
  }

  // -------------------------
  // Main factory function
  // -------------------------
  function zjs(userConfig = {}) {
    // Defaults
    const memoryCache = new Map();
    const plugins = [];
    const globalErrors = [];
    const defaultConfig = {
      baseURL: userConfig.baseURL || "",
      timeout: userConfig.timeout || 0,
      headers: Object.assign({}, userConfig.headers || {}),
      interceptors: {
        request: [],   // (cfg) => cfg
        response: []   // (res) => res
      },
      transformRequest: [],   // (data, headers) => newData
      transformResponse: [],  // (data, res) => newData
      maxConcurrent: typeof userConfig.maxConcurrent === "number" ? userConfig.maxConcurrent : Infinity
    };

    // If baseURL is an env chain-like object, resolve it now.
    if (isObj(defaultConfig.baseURL) && typeof defaultConfig.baseURL.resolve === "function") {
      try {
        defaultConfig.baseURL = defaultConfig.baseURL.resolve();
      } catch {
        defaultConfig.baseURL = String(defaultConfig.baseURL.toString ? defaultConfig.baseURL.toString() : "");
      }
    } else if (isObj(defaultConfig.baseURL) && typeof defaultConfig.baseURL.toString === "function") {
      defaultConfig.baseURL = defaultConfig.baseURL.toString();
    }

    // concurrency queue
    let activeCount = 0;
    const queue = [];

    function enqueue(task) {
      return new Promise((resolve, reject) => {
        const run = () => {
          activeCount++;
          task().then(resolve, reject).finally(() => {
            activeCount--;
            if (queue.length) {
              const next = queue.shift();
              next();
            }
          });
        };
        if (activeCount < defaultConfig.maxConcurrent) run();
        else queue.push(run);
      });
    }

    // Utility: build full URL with baseURL
    function fullUrl(url) {
      if (!url) return defaultConfig.baseURL || "";
      if (/^https?:\/\//i.test(url)) return url;
      const base = defaultConfig.baseURL || "";
      if (!base) return url;
      return base.endsWith("/") || url.startsWith("/") ? `${base.replace(/\/+$/,'')}/${url.replace(/^\/+/,'')}` : `${base}/${url.replace(/^\/+/,'')}`;
    }

    // Utility: cache
    function makeCacheKey(method, url, body) {
      let b = "";
      try { b = body ? JSON.stringify(body) : ""; } catch { b = String(body); }
      return `${method.toUpperCase()}::${url}::${b}`;
    }

    function getCached(key) {
      const entry = memoryCache.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        memoryCache.delete(key);
        return null;
      }
      return entry.value;
    }

    // Cancel token & group
    function CancelToken() {
      const ctrl = new AbortController();
      return {
        signal: ctrl.signal,
        cancel: (reason) => ctrl.abort(reason)
      };
    }

    function cancelGroup() {
      const ctrl = new AbortController();
      return {
        signal: ctrl.signal,
        cancel: (reason) => ctrl.abort(reason)
      };
    }

    // Apply interceptors
    function applyRequestInterceptors(cfg) {
      let modified = cfg;
      for (const fn of defaultConfig.interceptors.request) {
        try { modified = fn(modified) || modified; } catch (e) { /* ignore */ }
      }
      return modified;
    }
    function applyResponseInterceptors(res) {
      let modified = res;
      for (const fn of defaultConfig.interceptors.response) {
        try { modified = fn(modified) || modified; } catch (e) { /* ignore */ }
      }
      return modified;
    }

    // Apply transforms
    function applyTransformRequest(data, headers) {
      let d = data;
      for (const fn of defaultConfig.transformRequest) {
        try { d = fn(d, headers) || d; } catch { /* ignore */ }
      }
      return d;
    }
    function applyTransformResponse(data, res) {
      let d = data;
      for (const fn of defaultConfig.transformResponse) {
        try { d = fn(d, res) || d; } catch { /* ignore */ }
      }
      return d;
    }

    // Global error runner
    function runGlobalErrors(err, cfg) {
      for (const h of globalErrors) {
        try { h(err, cfg); } catch (e) { /* ignore handler errors */ }
      }
    }

    // Retry/backoff helper: returns Promise that resolves to fetch result or throws after attempts
    async function fetchWithRetry(cfg) {
      const {
        url, options,
        retries = 0,
        retryDelay = 300, // base ms
        retryOn = [429, 502, 503, 504], // status codes to retry
        timeout // ms
      } = cfg;

      let attempt = 0;
      const start = Date.now();

      while (true) {
        attempt++;
        // build AbortController merging any passed signal
        const ac = new AbortController();
        if (options && options.signal) {
          try {
            options.signal.addEventListener("abort", () => ac.abort(), { once: true });
          } catch {}
        }
        // timeout controller
        let timeoutId;
        if (typeof timeout === "number" && timeout > 0) {
          timeoutId = setTimeout(() => ac.abort(), timeout);
        }
        const finalOptions = Object.assign({}, options, { signal: ac.signal });
        let res;
        try {
          res = await fetch(url, finalOptions);
          if (timeoutId) clearTimeout(timeoutId);
        } catch (err) {
          if (timeoutId) clearTimeout(timeoutId);
          // If aborted by signal, rethrow immediately
          if (ac.signal && ac.signal.aborted && err && err.name === "AbortError") {
            throw err;
          }
          // network error: retry if possible
          if (attempt <= retries) {
            const backoff = retryDelay * Math.pow(2, attempt - 1);
            const jitter = Math.floor(Math.random() * retryDelay);
            await new Promise(r => setTimeout(r, backoff + jitter));
            continue;
          }
          throw err;
        }

        // got response: maybe retry on specific status
        if (!res.ok && attempt <= retries && retryOn.includes(res.status)) {
          const backoff = retryDelay * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * retryDelay);
          await new Promise(r => setTimeout(r, backoff + jitter));
          continue;
        }

        const duration = Date.now() - start;
        return { res, duration };
      }
    }

    // Core handler
    async function handleFetchRaw(method, urlPath, opts = {}) {
      const url = fullUrl(urlPath);
      let headers = Object.assign({}, defaultConfig.headers, opts.headers || {});
      let body = ("body" in opts) ? opts.body : (opts.data !== undefined ? opts.data : undefined);
      let timeout = ("timeout" in opts) ? opts.timeout : defaultConfig.timeout;
      const retries = ("retry" in opts) ? opts.retry : (opts.retries || 0);
      const retryDelay = opts.retryDelay || 300;
      const cacheTTL = opts.cache || 0; // seconds
      const groupSignal = opts.group && opts.group.signal ? opts.group.signal : null;

      // Transforms: run transformRequest BEFORE stringifying if necessary
      body = applyTransformRequest(body, headers);

      let options = {
        method: method.toUpperCase(),
        headers: Object.assign({}, headers),
        body: undefined,
      };

      if (body != null && method !== "GET" && method !== "HEAD") {
        // normalize content-type check (case-insensitive)
        const ctHeader = Object.keys(options.headers).find(k => k.toLowerCase() === "content-type");
        const ct = ctHeader ? String(options.headers[ctHeader]) : "";
        if (ct && ct.includes("application/json") && typeof body !== "string") {
          options.body = JSON.stringify(body);
        } else {
          options.body = body;
        }
      }

      // allow user-provided signal / cancel token
      if (opts.signal) options.signal = opts.signal;

      if (groupSignal) {
        // combine signals: if either aborts, abort composed controller
        const combined = new AbortController();
        if (options.signal && typeof options.signal.addEventListener === "function") {
          try { options.signal.addEventListener("abort", () => combined.abort(), { once: true }); } catch {}
        }
        if (groupSignal && typeof groupSignal.addEventListener === "function") {
          try { groupSignal.addEventListener("abort", () => combined.abort(), { once: true }); } catch {}
        }
        options.signal = combined.signal;
      }

      // Build interceptor config
      let cfg = {
        url,
        method: options.method,
        options,
        timeout,
        retries,
        retryDelay,
        cacheTTL,
        original: { url: urlPath, opts }
      };

      // Run request interceptors
      cfg = applyRequestInterceptors(cfg) || cfg;
      // apply any plugin changes that might have mutated options/timeout/headers
      options = cfg.options;
      timeout = cfg.timeout;
      const finalUrl = cfg.url;

      // Caching only for GET requests
      const cacheKey = makeCacheKey(cfg.method, finalUrl, options && options.body);
      if (cfg.method === "GET" && cacheTTL > 0) {
        const cached = getCached(cacheKey);
        if (cached) {
          // run response interceptors and transforms
          let response = Object.assign({}, cached);
          response = applyResponseInterceptors(response) || response;
          response.data = applyTransformResponse(response.data, response) || response.data;
          return response;
        }
      }

      // Enqueue respecting concurrency
      const task = async () => {
        let fetchResult;
        try {
          fetchResult = await fetchWithRetry({
            url: finalUrl,
            options,
            retries: cfg.retries,
            retryDelay: cfg.retryDelay,
            timeout
          });
        } catch (err) {
          // network / abort error
          const out = {
            ok: false,
            status: 0,
            data: null,
            error: err,
            config: cfg
          };
          runGlobalErrors(err, cfg);
          return out;
        }

        const { res, duration } = fetchResult;

        const contentType = (res.headers && res.headers.get ? (res.headers.get("Content-Type") || "") : "");
        let data = null;
        if (contentType.includes("application/json")) {
          data = await safeJson(res);
        } else {
          data = await res.text().catch(() => null);
        }

        const response = {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
          data,
          config: cfg,
          time: duration
        };

        // Run transformResponse
        response.data = applyTransformResponse(response.data, response);

        // Run response interceptors
        let finalResponse = applyResponseInterceptors(response) || response;

        // On error status, call global handlers
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} ${res.statusText}`);
          err.status = res.status;
          err.response = finalResponse;
          runGlobalErrors(err, cfg);
          return { ok: false, status: res.status, data: finalResponse.data, error: err, config: cfg };
        }

        // Cache write
        if (cfg.method === "GET" && cacheTTL > 0) {
          memoryCache.set(cacheKey, {
            value: finalResponse,
            expiresAt: cacheTTL > 0 ? Date.now() + cacheTTL * 1000 : null
          });
        }

        return finalResponse;
      };

      return enqueue(task);
    }

    // API instance object
    const api = {};

    // Core HTTP verbs
    ["get", "post", "put", "patch", "delete", "head"].forEach(method => {
      api[method] = (url, bodyOrOptions = {}, maybeOptions = {}) => {
        let body = null, options = {};
        if (method === "get" || method === "head" || method === "delete") {
          options = bodyOrOptions || {};
        } else {
          body = bodyOrOptions;
          options = maybeOptions || {};
          if (!options.headers) options.headers = {};
          // default json header if body is object and content-type not set
          const existingCT = Object.keys(options.headers).find(k => k.toLowerCase() === "content-type");
          if (!existingCT && isObj(body)) options.headers["Content-Type"] = "application/json";
          options.body = body;
        }
        return handleFetchRaw(method, url, options);
      };
    });

    // raw request
    api.request = (options = {}) => {
      const method = (options.method || "GET").toLowerCase();
      const url = options.url || options.path || options.pathname || "";
      if (["get","post","put","patch","delete","head"].includes(method)) {
        if (method === "get" || method === "head" || method === "delete") {
          return api[method](url, options);
        }
        return api[method](url, options.data || options.body || {}, options);
      }
      return handleFetchRaw(method, url, options);
    };

    // interceptors
    api.use = function (handlers = {}) {
      if (typeof handlers.request === "function") defaultConfig.interceptors.request.push(handlers.request);
      if (typeof handlers.response === "function") defaultConfig.interceptors.response.push(handlers.response);
      return api;
    };

    // transform hooks
    api.addTransformRequest = fn => { if (typeof fn === "function") defaultConfig.transformRequest.push(fn); return api; };
    api.addTransformResponse = fn => { if (typeof fn === "function") defaultConfig.transformResponse.push(fn); return api; };

    // Plugins
    api.usePlugin = function (plugin) {
      if (typeof plugin === "function") {
        try { plugin(api, defaultConfig); plugins.push(plugin); } catch (e) { /* ignore plugin errors */ }
      }
      return api;
    };

    // Global error registration
    api.onError = function (fn) {
      if (typeof fn === "function") globalErrors.push(fn);
      return api;
    };

    // Cancel helpers
    api.CancelToken = CancelToken;
    api.cancelGroup = cancelGroup;

    // all helper (parallel)
    api.all = function (arr) {
      return Promise.all(arr);
    };

    // setToken helper (auto set Authorization: Bearer)
    api.setToken = function (token, type = "Bearer") {
      if (token) defaultConfig.headers["Authorization"] = `${type} ${token}`;
      else delete defaultConfig.headers["Authorization"];
      return api;
    };

    // cache management
    api.clearCache = function () { memoryCache.clear(); return api; };
    api.deleteCacheKey = function (method, url, body) { memoryCache.delete(makeCacheKey(method, url, body)); return api; };

    // expose config
    api.config = defaultConfig;

    // expose internal for debugging
    api._internal = { memoryCache, plugins, globalErrors };

    return api;
  }

  // Attach env builder to factory function
  zjs.env = function () {
    return createEnvChain();
  };

  // expose globally (CommonJS/Browser)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = zjs;
  } else {
    global.zjs = zjs;
  }

})(typeof window !== "undefined" ? window : (typeof global !== "undefined" ? global : this));
