if (process.env.USE_MOCK_REDDIT === 'true') {
  module.exports = require('./mockRedditService');
  return;
}

const axios = require('axios');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestTime = 0;
const configuredDelay = Number(process.env.REDDIT_REQUEST_DELAY_MS);
const MIN_INTERVAL_MS =
  Number.isFinite(configuredDelay) && configuredDelay > 0
    ? Math.max(configuredDelay, 1500)
    : 2000;

function userAgent() {
  return (
    process.env.REDDIT_USER_AGENT ||
    'Mozilla/5.0 (compatible; Signal/1.0; +https://github.com/signal)'
  );
}

function parseRedditError(err) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const message =
    (typeof body === 'string' && body) ||
    body?.message ||
    body?.error ||
    err?.message ||
    'Reddit API error';

  if (status === 403) {
    return {
      code: 'REDDIT_BLOCKED',
      status,
      message: `Reddit blocked the request (403). Set REDDIT_USER_AGENT in .env to a descriptive value. ${message}`,
    };
  }
  if (status === 429) {
    return { code: 'REDDIT_RATE_LIMITED', status, message: String(message) };
  }
  return {
    code: 'REDDIT_API_ERROR',
    status: status || null,
    message: String(message),
  };
}

/** @deprecated OAuth not used — kept for scripts that import it */
async function getAccessToken() {
  return null;
}

function redditCredentialsPresent() {
  return Boolean(process.env.REDDIT_USER_AGENT);
}

async function enforceRateLimit() {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

async function jsonGet(url, params = {}, attempt = 1) {
  await enforceRateLimit();

  try {
    const { data } = await axios.get(url, {
      params: { ...params, raw_json: 1 },
      headers: {
        'User-Agent': userAgent(),
        Accept: 'application/json',
      },
      timeout: 30000,
    });
    return data;
  } catch (err) {
    const error = parseRedditError(err);
    const maxAttempts = Number(process.env.REDDIT_429_MAX_RETRIES) || 3;
    if (error.code === 'REDDIT_RATE_LIMITED' && attempt < maxAttempts) {
      const waitMs = Number(process.env.REDDIT_429_BACKOFF_MS) || 60_000;
      console.warn(
        `[redditService] Reddit 429 — waiting ${Math.round(waitMs / 1000)}s (retry ${attempt + 1}/${maxAttempts})`
      );
      await sleep(waitMs);
      return jsonGet(url, params, attempt + 1);
    }
    const wrapped = new Error(error.message);
    wrapped.redditError = error;
    throw wrapped;
  }
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
  const out = [];

  for (const child of children) {
    const kind = child?.kind;

    try {
      if (kind === 't3') {
        out.push(normalizePost(child));
      } else if (kind === 't1') {
        out.push(normalizeComment(child));
      }
    } catch {
      // skip malformed child
    }
  }

  return out;
}

async function fetchSearchListing(params) {
  const data = await jsonGet('https://www.reddit.com/search.json', params);
  return normalizeListing(data);
}

async function fetchSubredditSearchListing(subreddit, params) {
  const sub = String(subreddit).replace(/^r\//, '');
  const data = await jsonGet(`https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json`, {
    restrict_sr: 'on',
    ...params,
  });
  return normalizeListing(data);
}

/**
 * Verify public Reddit JSON API is reachable (no OAuth).
 */
async function validateRedditCredentials() {
  try {
    const items = await fetchSearchListing({
      q: 'small business software',
      sort: 'new',
      limit: 3,
      type: 'link',
    });
    return {
      ok: true,
      mode: 'public_json',
      sample_count: items.length,
    };
  } catch (err) {
    const error = err.redditError || parseRedditError(err);
    return { ok: false, error };
  }
}

async function searchRedditStructured(query) {
  try {
    const perPage =
      Number(process.env.REDDIT_SEARCH_LIMIT) > 0 ? Number(process.env.REDDIT_SEARCH_LIMIT) : 25;

    const linkItems = await fetchSearchListing({
      q: query,
      sort: 'new',
      limit: perPage,
      type: 'link',
    });

    const commentItems = await fetchSearchListing({
      q: query,
      sort: 'new',
      limit: perPage,
      type: 'comment',
    });

    return {
      ok: true,
      items: [...linkItems, ...commentItems],
    };
  } catch (err) {
    const error = err.redditError || parseRedditError(err);
    console.error('[redditService] searchReddit:', error);
    if (error.code === 'REDDIT_BLOCKED') {
      const wrapped = new Error(error.message);
      wrapped.redditError = error;
      throw wrapped;
    }
    return { ok: false, items: [], error };
  }
}

async function searchSubredditStructured(subreddit, query) {
  try {
    const perPage =
      Number(process.env.REDDIT_SEARCH_LIMIT) > 0 ? Number(process.env.REDDIT_SEARCH_LIMIT) : 25;

    const linkItems = await fetchSubredditSearchListing(subreddit, {
      q: query,
      sort: 'new',
      limit: perPage,
      type: 'link',
    });

    const commentItems = await fetchSubredditSearchListing(subreddit, {
      q: query,
      sort: 'new',
      limit: perPage,
      type: 'comment',
    });

    return {
      ok: true,
      items: [...linkItems, ...commentItems],
    };
  } catch (err) {
    const error = err.redditError || parseRedditError(err);
    console.error('[redditService] searchSubreddit:', error);
    if (error.code === 'REDDIT_BLOCKED') {
      const wrapped = new Error(error.message);
      wrapped.redditError = error;
      throw wrapped;
    }
    return { ok: false, items: [], error };
  }
}

async function searchReddit(query) {
  const result = await searchRedditStructured(query);
  if (!result.ok) {
    if (result.error?.code === 'REDDIT_BLOCKED' || result.error?.code === 'REDDIT_RATE_LIMITED') {
      throw Object.assign(new Error(result.error.message), { redditError: result.error });
    }
    return [];
  }
  return result.items;
}

async function searchSubreddit(subreddit, query) {
  const result = await searchSubredditStructured(subreddit, query);
  if (!result.ok) {
    if (result.error?.code === 'REDDIT_BLOCKED' || result.error?.code === 'REDDIT_RATE_LIMITED') {
      throw Object.assign(new Error(result.error.message), { redditError: result.error });
    }
    return [];
  }
  return result.items;
}

module.exports = {
  getAccessToken,
  validateRedditCredentials,
  redditCredentialsPresent,
  searchReddit,
  searchSubreddit,
  searchRedditStructured,
  searchSubredditStructured,
  parseRedditError,
};
