if (process.env.USE_MOCK_REDDIT === 'true') {
  module.exports = require('./mockRedditService');
  return;
}

const axios = require('axios');

const tokenCache = { token: null, expiresAt: 0 };

/** @type {number} unix seconds */
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestTime = 0;
const MIN_INTERVAL_MS = 1100;

async function enforceRateLimit() {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

async function getAccessToken() {
  const t = nowSec();
  if (
    tokenCache.token != null &&
    t < tokenCache.expiresAt - 60
  ) {
    return tokenCache.token;
  }

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT;

  await enforceRateLimit();

  const { data } = await axios.post(
    'https://www.reddit.com/api/v1/access_token',
    'grant_type=client_credentials',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
      },
      auth: {
        username: clientId,
        password: clientSecret,
      },
    }
  );

  tokenCache.token = data.access_token;
  const ttl = Number(data.expires_in);
  tokenCache.expiresAt =
    nowSec() +
    (Number.isFinite(ttl) && ttl > 0 ? ttl : 3300);

  return tokenCache.token;
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
  };
}

async function oauthGet(token, url, params) {
  await enforceRateLimit();

  const { data } = await axios.get(url, {
    params,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': process.env.REDDIT_USER_AGENT,
    },
  });

  return data;
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

async function searchReddit(query) {
  try {
    const token = await getAccessToken();

    const linkData = await oauthGet(token, 'https://oauth.reddit.com/search', {
      q: query,
      sort: 'new',
      limit: 25,
      type: 'link',
    });

    const commentData = await oauthGet(token, 'https://oauth.reddit.com/search', {
      q: query,
      sort: 'new',
      limit: 25,
      type: 'comment',
    });

    return [...normalizeListing(linkData), ...normalizeListing(commentData)];
  } catch (err) {
    console.error('[redditService] searchReddit:', err.response?.data || err.message || err);
    return [];
  }
}

async function searchSubreddit(subreddit, query) {
  try {
    const token = await getAccessToken();
    const path = `/r/${subreddit.replace(/^r\//, '')}/search`;
    const base = `https://oauth.reddit.com${path}`;

    const linkData = await oauthGet(token, base, {
      q: query,
      sort: 'new',
      limit: 25,
      restrict_sr: true,
      type: 'link',
    });

    const commentData = await oauthGet(token, base, {
      q: query,
      sort: 'new',
      limit: 25,
      restrict_sr: true,
      type: 'comment',
    });

    return [...normalizeListing(linkData), ...normalizeListing(commentData)];
  } catch (err) {
    console.error(
      '[redditService] searchSubreddit:',
      err.response?.data || err.message || err
    );
    return [];
  }
}

module.exports = {
  searchReddit,
  searchSubreddit,
};
