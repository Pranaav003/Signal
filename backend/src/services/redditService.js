if (process.env.USE_MOCK_REDDIT === 'true') {
  module.exports = require('./mockRedditService');
  return;
}

const axios = require('axios');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tokenCache = { token: null, expiresAt: 0 };
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

function oauthCredentialsPresent() {
  return Boolean(
    process.env.REDDIT_CLIENT_ID &&
      process.env.REDDIT_CLIENT_SECRET &&
      process.env.REDDIT_USER_AGENT
  );
}

function resolveRedditMode() {
  const raw = String(process.env.REDDIT_MODE || 'auto').toLowerCase();
  if (raw === 'oauth') {
    if (!oauthCredentialsPresent()) {
      throw new Error(
        'REDDIT_MODE=oauth but REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, or REDDIT_USER_AGENT is missing'
      );
    }
    return 'oauth';
  }
  if (raw === 'public_json') return 'public_json';
  return oauthCredentialsPresent() ? 'oauth' : 'public_json';
}

function getActiveRedditMode() {
  try {
    return resolveRedditMode();
  } catch {
    return 'public_json';
  }
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

  if (status === 401 || status === 403) {
    return {
      code: status === 401 ? 'REDDIT_AUTH_FAILED' : 'REDDIT_BLOCKED',
      status,
      message: String(message),
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

async function jsonGet(url, params = {}, attempt = 1) {
  await enforceRateLimit();
  try {
    const { data } = await axios.get(url, {
      params: { ...params, raw_json: 1 },
      headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
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

async function oauthGet(token, url, params) {
  await enforceRateLimit();
  const { data } = await axios.get(url, {
    params,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': userAgent(),
    },
    timeout: 30000,
  });
  return data;
}

async function getAccessToken() {
  if (!oauthCredentialsPresent()) {
    const err = new Error('Reddit OAuth credentials missing');
    err.redditError = { code: 'REDDIT_AUTH_FAILED', message: err.message };
    throw err;
  }

  const t = Math.floor(Date.now() / 1000);
  if (tokenCache.token && t < tokenCache.expiresAt - 60) {
    return tokenCache.token;
  }

  await enforceRateLimit();
  const { data } = await axios.post(
    'https://www.reddit.com/api/v1/access_token',
    'grant_type=client_credentials',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent(),
      },
      auth: {
        username: process.env.REDDIT_CLIENT_ID,
        password: process.env.REDDIT_CLIENT_SECRET,
      },
    }
  );

  tokenCache.token = data.access_token;
  const ttl = Number(data.expires_in);
  tokenCache.expiresAt = t + (Number.isFinite(ttl) && ttl > 0 ? ttl : 3300);
  return tokenCache.token;
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

async function searchRedditOAuthStructured(query) {
  try {
    const token = await getAccessToken();
    const limit = searchLimit();

    const linkData = await oauthGet(token, 'https://oauth.reddit.com/search', {
      q: query,
      sort: 'new',
      limit,
      type: 'link',
    });
    const commentData = await oauthGet(token, 'https://oauth.reddit.com/search', {
      q: query,
      sort: 'new',
      limit,
      type: 'comment',
    });

    const linkListing = normalizeListing(linkData);
    const commentListing = normalizeListing(commentData);
    const items = listingToItems(linkListing).concat(listingToItems(commentListing));

    return {
      ok: true,
      items,
      meta: {
        mode: 'oauth',
        post_count: linkListing.posts.length + commentListing.posts.length,
        comment_count: linkListing.comments.length + commentListing.comments.length,
      },
    };
  } catch (err) {
    const error = err.redditError || parseRedditError(err);
    if (error.code === 'REDDIT_BLOCKED' || error.code === 'REDDIT_AUTH_FAILED') {
      throw Object.assign(new Error(error.message), { redditError: error });
    }
    return { ok: false, items: [], error, meta: { mode: 'oauth' } };
  }
}

async function searchSubredditOAuthStructured(subreddit, query) {
  try {
    const token = await getAccessToken();
    const sub = String(subreddit).replace(/^r\//, '');
    const base = `https://oauth.reddit.com/r/${sub}/search`;
    const limit = searchLimit();

    const linkData = await oauthGet(token, base, {
      q: query,
      sort: 'new',
      limit,
      restrict_sr: true,
      type: 'link',
    });
    const commentData = await oauthGet(token, base, {
      q: query,
      sort: 'new',
      limit,
      restrict_sr: true,
      type: 'comment',
    });

    const linkListing = normalizeListing(linkData);
    const commentListing = normalizeListing(commentData);
    const items = listingToItems(linkListing).concat(listingToItems(commentListing));

    return {
      ok: true,
      items,
      meta: {
        mode: 'oauth',
        post_count: linkListing.posts.length + commentListing.posts.length,
        comment_count: linkListing.comments.length + commentListing.comments.length,
      },
    };
  } catch (err) {
    const error = err.redditError || parseRedditError(err);
    if (error.code === 'REDDIT_BLOCKED' || error.code === 'REDDIT_AUTH_FAILED') {
      throw Object.assign(new Error(error.message), { redditError: error });
    }
    return { ok: false, items: [], error, meta: { mode: 'oauth' } };
  }
}

async function searchRedditStructured(query) {
  const mode = resolveRedditMode();
  return mode === 'oauth'
    ? searchRedditOAuthStructured(query)
    : searchRedditPublicStructured(query);
}

async function searchSubredditStructured(subreddit, query) {
  const mode = resolveRedditMode();
  return mode === 'oauth'
    ? searchSubredditOAuthStructured(subreddit, query)
    : searchSubredditPublicStructured(subreddit, query);
}

async function validateRedditCredentials() {
  const mode = getActiveRedditMode();
  try {
    const result = await (mode === 'oauth'
      ? searchRedditOAuthStructured('small business software')
      : searchRedditPublicStructured('small business software'));
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
  return oauthCredentialsPresent() || Boolean(userAgent());
}

module.exports = {
  getAccessToken,
  validateRedditCredentials,
  redditCredentialsPresent,
  oauthCredentialsPresent,
  resolveRedditMode,
  getActiveRedditMode,
  searchReddit,
  searchSubreddit,
  searchRedditStructured,
  searchSubredditStructured,
  searchRedditPublicStructured,
  searchSubredditPublicStructured,
  searchRedditOAuthStructured,
  searchSubredditOAuthStructured,
  parseRedditError,
};
