if (process.env.USE_MOCK_REDDIT === 'true') {
  module.exports = require('./mockRedditService');
  return;
}

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestTime = 0;

const configuredDelay = Number(process.env.REDDIT_REQUEST_DELAY_MS);
const MIN_INTERVAL_MS =
  Number.isFinite(configuredDelay) && configuredDelay > 0
    ? Math.max(configuredDelay, 1500)
    : 2000;

const DEFAULT_PROXY_USERNAMES = [
  'qcceojoh-gb-1',
  'qcceojoh-ca-2',
  'qcceojoh-de-3',
  'qcceojoh-fr-4',
  'qcceojoh-au-5',
  'qcceojoh-nl-6',
  'qcceojoh-it-7',
  'qcceojoh-es-8',
  'qcceojoh-be-9',
  'qcceojoh-at-10',
].join(',');

const PROXY_LIST = (
  process.env.PROXY_LIST ||
  (process.env.PROXY_HOST
    ? `${process.env.PROXY_HOST}:${process.env.PROXY_PORT || 80}`
    : 'p.webshare.io:80')
)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const PROXY_USERNAMES = (
  process.env.PROXY_USERNAMES ||
  process.env.PROXY_USERNAME ||
  DEFAULT_PROXY_USERNAMES
)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const PROXY_PASSWORD = process.env.PROXY_PASSWORD || 'ux6ov8h3qm1o';

function pickProxyUsername(excludeUsername) {
  const pool = excludeUsername
    ? PROXY_USERNAMES.filter((name) => name !== excludeUsername)
    : PROXY_USERNAMES;
  const source = pool.length ? pool : PROXY_USERNAMES;
  return source[Math.floor(Math.random() * source.length)];
}

function buildProxyConfig(entry, username) {
  const [host, port] = String(entry || '').split(':');
  if (!host || !port) return null;
  const resolvedUsername = username || pickProxyUsername();
  if (!resolvedUsername) return null;
  return {
    protocol: 'http',
    host,
    port: Number(port),
    auth: { username: resolvedUsername, password: PROXY_PASSWORD },
  };
}

function getProxy(entry, username) {
  if (process.env.PROXY_ENABLED === 'false') return null;
  if (!PROXY_LIST.length || !PROXY_USERNAMES.length) return null;
  const chosen = entry || PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
  return buildProxyConfig(chosen, username);
}

function proxyAgentFor(proxy) {
  if (!proxy) return null;
  const auth =
    proxy.auth?.username && proxy.auth?.password
      ? `${encodeURIComponent(proxy.auth.username)}:${encodeURIComponent(proxy.auth.password)}@`
      : '';
  const url = `${proxy.protocol || 'http'}://${auth}${proxy.host}:${proxy.port}`;
  return new HttpsProxyAgent(url);
}

function isRotatingProxy() {
  if (process.env.PROXY_ROTATING === 'true') return true;
  if (process.env.PROXY_ROTATING === 'false') return false;
  return (
    PROXY_USERNAMES.length > 1 ||
    (PROXY_LIST.length === 1 && /webshare\.io/i.test(PROXY_LIST[0]))
  );
}

function shuffledProxyUsernames() {
  const usernames = [...PROXY_USERNAMES];
  for (let i = usernames.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [usernames[i], usernames[j]] = [usernames[j], usernames[i]];
  }
  return usernames;
}

function shuffledProxyEntries() {
  const entries = [...PROXY_LIST];
  for (let i = entries.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return entries;
}

function userAgent() {
  return (
    process.env.REDDIT_USER_AGENT ||
    'Signal/1.0 (by /u/Pranaav003; lead monitor; +https://github.com/Pranaav003/Signal)'
  );
}

function sanitizeRedditMessage(raw) {
  const text = String(raw || '').trim();
  if (!text) return 'Reddit API error';

  if (
    /blocked by network security/i.test(text) ||
    /<!doctype html|<html|<body class=/i.test(text)
  ) {
    return 'Reddit blocked this request (network security). Try another proxy in PROXY_LIST or set PROXY_ENABLED=false to debug without a proxy.';
  }

  if (text.length > 280) return `${text.slice(0, 277)}...`;
  return text;
}

function isRedditHtmlBlock(body) {
  if (body == null) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return (
    /blocked by network security/i.test(text) ||
    /<!doctype html|<html|<body class=/i.test(text)
  );
}

function resolveRedditMode() {
  return 'public_json';
}

function getActiveRedditMode() {
  return 'public_json';
}

function parseRedditError(err) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const rawMessage =
    (typeof body === 'string' && body) ||
    body?.message ||
    body?.error ||
    err?.message ||
    'Reddit API error';
  const message = sanitizeRedditMessage(rawMessage);

  if (status === 401 || status === 403 || isRedditHtmlBlock(body)) {
    return {
      code: status === 401 ? 'REDDIT_AUTH_FAILED' : 'REDDIT_BLOCKED',
      status: status || 403,
      message,
    };
  }
  if (status === 429) {
    return { code: 'REDDIT_RATE_LIMITED', status, message };
  }
  return {
    code: 'REDDIT_API_ERROR',
    status: status || null,
    message,
  };
}

async function enforceRateLimit() {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

function normalizePost(post) {
  return {
    post_id: post.data.name,
    title: post.data.title || '',
    body_snippet: (post.data.selftext || '').slice(0, 500),
    url: 'https://reddit.com' + post.data.permalink,
    author: post.data.author,
    subreddit: post.data.subreddit,
    created_utc: post.data.created_utc,
    type: 'post',
    platform: 'reddit',
  };
}

function normalizeComment(comment) {
  return {
    post_id: comment.data.name,
    title: '',
    body_snippet: (comment.data.body || '').slice(0, 500),
    url: 'https://reddit.com' + comment.data.permalink,
    author: comment.data.author,
    subreddit: comment.data.subreddit,
    created_utc: comment.data.created_utc,
    type: 'comment',
    platform: 'reddit',
  };
}

function normalizeListing(data) {
  const children = data?.data?.children || [];
  const out = { posts: [], comments: [] };

  for (const child of children) {
    try {
      if (child?.kind === 't3') out.posts.push(normalizePost(child));
      else if (child?.kind === 't1') out.comments.push(normalizeComment(child));
    } catch {
      /* skip */
    }
  }

  return out;
}

function listingToItems(listing) {
  return [...listing.posts, ...listing.comments];
}

async function jsonGet(url, params = {}, attempt = 1, proxyEntry = null, proxyUsername = null) {
  await enforceRateLimit();
  try {
    const proxy = getProxy(proxyEntry, proxyUsername);
    const agent = proxyAgentFor(proxy);
    const { data, headers, status } = await axios.get(url, {
      params: { ...params, raw_json: 1 },
      headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
      timeout: 30000,
      validateStatus: (httpStatus) => httpStatus >= 200 && httpStatus < 500,
      proxy: false,
      ...(agent && { httpAgent: agent, httpsAgent: agent }),
    });

    if (status >= 400) {
      const error = parseRedditError({ response: { status, data } });
      const wrapped = new Error(error.message);
      wrapped.redditError = error;
      wrapped.proxyEntry = proxyEntry;
      wrapped.proxyUsername = proxyUsername;
      throw wrapped;
    }

    const contentType = String(headers?.['content-type'] || '');
    if (isRedditHtmlBlock(data) || /text\/html/i.test(contentType)) {
      const error = {
        code: 'REDDIT_BLOCKED',
        status: 403,
        message: sanitizeRedditMessage(
          typeof data === 'string' ? data : 'Reddit returned an HTML block page instead of JSON.'
        ),
      };
      const wrapped = new Error(error.message);
      wrapped.redditError = error;
      wrapped.proxyEntry = proxyEntry;
      wrapped.proxyUsername = proxyUsername;
      throw wrapped;
    }

    if (!data || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, 'data')) {
      const error = {
        code: 'REDDIT_API_ERROR',
        status: null,
        message: 'Reddit returned an unexpected response format.',
      };
      const wrapped = new Error(error.message);
      wrapped.redditError = error;
      throw wrapped;
    }

    return data;
  } catch (err) {
    const error = err.redditError || parseRedditError(err);
    const max429Attempts = Number(process.env.REDDIT_429_MAX_RETRIES) || 3;
    if (error.code === 'REDDIT_RATE_LIMITED' && attempt < max429Attempts) {
      const waitMs = Number(process.env.REDDIT_429_BACKOFF_MS) || 60_000;
      console.warn(
        `[redditService] Reddit 429 — waiting ${Math.round(waitMs / 1000)}s (retry ${attempt + 1}/${max429Attempts})`
      );
      await sleep(waitMs);
      return jsonGet(url, params, attempt + 1, proxyEntry, proxyUsername);
    }

    if (
      proxyEnabled() &&
      (error.code === 'REDDIT_BLOCKED' || error.code === 'REDDIT_AUTH_FAILED')
    ) {
      const maxBlockRetries =
        Number(process.env.REDDIT_PROXY_BLOCK_RETRIES) ||
        (isRotatingProxy() ? Math.max(PROXY_USERNAMES.length, 5) : PROXY_LIST.length);

      if (isRotatingProxy() && attempt < maxBlockRetries) {
        const nextUser = pickProxyUsername(proxyUsername);
        console.warn(
          `[redditService] Reddit blocked — retry ${attempt + 1}/${maxBlockRetries} via ${nextUser}`
        );
        await sleep(750);
        return jsonGet(url, params, attempt + 1, proxyEntry || PROXY_LIST[0], nextUser);
      }

      const triedUsers = new Set([proxyUsername].filter(Boolean));
      for (const nextUser of shuffledProxyUsernames()) {
        if (triedUsers.has(nextUser)) continue;
        triedUsers.add(nextUser);
        console.warn(
          `[redditService] Reddit blocked via ${proxyUsername || 'direct'} — retrying ${nextUser}`
        );
        try {
          return await jsonGet(url, params, attempt, proxyEntry || PROXY_LIST[0], nextUser);
        } catch (retryErr) {
          const retryError = retryErr.redditError || parseRedditError(retryErr);
          if (retryError.code !== 'REDDIT_BLOCKED' && retryError.code !== 'REDDIT_AUTH_FAILED') {
            throw retryErr;
          }
        }
      }

      const triedEntries = new Set([proxyEntry].filter(Boolean));
      for (const nextEntry of shuffledProxyEntries()) {
        if (triedEntries.has(nextEntry)) continue;
        triedEntries.add(nextEntry);
        const nextUser = pickProxyUsername();
        console.warn(`[redditService] Reddit blocked — retrying ${nextEntry} as ${nextUser}`);
        try {
          return await jsonGet(url, params, attempt, nextEntry, nextUser);
        } catch (retryErr) {
          const retryError = retryErr.redditError || parseRedditError(retryErr);
          if (retryError.code !== 'REDDIT_BLOCKED' && retryError.code !== 'REDDIT_AUTH_FAILED') {
            throw retryErr;
          }
        }
      }
    }

    const wrapped = new Error(error.message);
    wrapped.redditError = error;
    throw wrapped;
  }
}

function searchLimit() {
  return Number(process.env.REDDIT_SEARCH_LIMIT) > 0 ? Number(process.env.REDDIT_SEARCH_LIMIT) : 25;
}

async function searchRedditPublicStructured(query) {
  try {
    const limit = searchLimit();
    const linkListing = normalizeListing(
      await jsonGet('https://www.reddit.com/search.json', {
        q: query,
        sort: 'new',
        limit,
        type: 'link',
      })
    );
    const commentListing = normalizeListing(
      await jsonGet('https://www.reddit.com/search.json', {
        q: query,
        sort: 'new',
        limit,
        type: 'comment',
      })
    );

    const items = [...linkListing.posts, ...commentListing.posts, ...linkListing.comments, ...commentListing.comments];

    return {
      ok: true,
      items,
      meta: {
        mode: 'public_json',
        post_count: linkListing.posts.length + commentListing.posts.length,
        comment_count: linkListing.comments.length + commentListing.comments.length,
      },
    };
  } catch (err) {
    const error = err.redditError || parseRedditError(err);
    if (error.code === 'REDDIT_BLOCKED' || error.code === 'REDDIT_AUTH_FAILED') {
      throw Object.assign(new Error(error.message), { redditError: error });
    }
    return { ok: false, items: [], error, meta: { mode: 'public_json' } };
  }
}

async function searchSubredditPublicStructured(subreddit, query) {
  try {
    const sub = String(subreddit).replace(/^r\//, '');
    const base = `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json`;
    const limit = searchLimit();

    const linkListing = normalizeListing(
      await jsonGet(base, { q: query, sort: 'new', limit, restrict_sr: 'on', type: 'link' })
    );
    const commentListing = normalizeListing(
      await jsonGet(base, { q: query, sort: 'new', limit, restrict_sr: 'on', type: 'comment' })
    );

    const items = [...linkListing.posts, ...commentListing.posts, ...linkListing.comments, ...commentListing.comments];

    return {
      ok: true,
      items,
      meta: {
        mode: 'public_json',
        post_count: linkListing.posts.length + commentListing.posts.length,
        comment_count: linkListing.comments.length + commentListing.comments.length,
      },
    };
  } catch (err) {
    const error = err.redditError || parseRedditError(err);
    if (error.code === 'REDDIT_BLOCKED' || error.code === 'REDDIT_AUTH_FAILED') {
      throw Object.assign(new Error(error.message), { redditError: error });
    }
    return { ok: false, items: [], error, meta: { mode: 'public_json' } };
  }
}

async function searchRedditStructured(query) {
  return searchRedditPublicStructured(query);
}

async function searchSubredditStructured(subreddit, query) {
  return searchSubredditPublicStructured(subreddit, query);
}

async function validateRedditCredentials() {
  const mode = getActiveRedditMode();
  try {
    const result = await searchRedditPublicStructured('small business software');
    return {
      ok: result.ok,
      mode,
      sample_count: result.items?.length || 0,
      meta: result.meta,
    };
  } catch (err) {
    return { ok: false, mode, error: err.redditError || { message: err.message } };
  }
}

async function searchReddit(query) {
  const result = await searchRedditStructured(query);
  return result.ok ? result.items : [];
}

async function searchSubreddit(subreddit, query) {
  const result = await searchSubredditStructured(subreddit, query);
  return result.ok ? result.items : [];
}

function redditCredentialsPresent() {
  return Boolean(userAgent());
}

function proxyEnabled() {
  return (
    process.env.PROXY_ENABLED !== 'false' &&
    PROXY_LIST.length > 0 &&
    PROXY_USERNAMES.length > 0
  );
}

function proxyStatusLabel() {
  if (!proxyEnabled()) return 'none';
  const [host, port] = PROXY_LIST[0].split(':');
  if (PROXY_USERNAMES.length > 1) {
    return `${host}:${port || 80} (residential, ${PROXY_USERNAMES.length} regions)`;
  }
  if (isRotatingProxy()) return `${host}:${port || 80} (rotating)`;
  return `${host}… (${PROXY_LIST.length} endpoints)`;
}

console.log(`[redditService] mode=${getActiveRedditMode()} proxy=${proxyStatusLabel()}`);

module.exports = {
  validateRedditCredentials,
  redditCredentialsPresent,
  resolveRedditMode,
  getActiveRedditMode,
  searchReddit,
  searchSubreddit,
  searchRedditStructured,
  searchSubredditStructured,
  searchRedditPublicStructured,
  searchSubredditPublicStructured,
  parseRedditError,
  sanitizeRedditMessage,
  getProxy,
  proxyEnabled,
};
