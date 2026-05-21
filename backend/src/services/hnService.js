const axios = require('axios');

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, '');
}

function normalizeHit(hit) {
  const storyId = hit?.story_id || hit?.objectID;
  return {
    post_id: `hn_${hit.objectID}`,
    title: hit.title || hit.story_title || '',
    body_snippet: decodeHtml(hit.comment_text || hit.story_text || '').slice(0, 500),
    url: hit.url || `https://news.ycombinator.com/item?id=${storyId}`,
    author: hit.author || null,
    subreddit: 'hackernews',
    created_utc: hit.created_at_i || null,
    type: hit.comment_text ? 'comment' : 'post',
    platform: 'hackernews',
  };
}

async function algoliaSearch(query, tag, hitsPerPage) {
  const { data } = await axios.get('https://hn.algolia.com/api/v1/search', {
    params: {
      query,
      tags: tag,
      hitsPerPage,
    },
    headers: { Accept: 'application/json' },
    timeout: 30000,
  });
  return data?.hits || [];
}

async function searchHNStructured(query) {
  try {
    const hitsPerPage =
      Number(process.env.HN_SEARCH_LIMIT) > 0 ? Number(process.env.HN_SEARCH_LIMIT) : 20;

    // Algolia treats "comment,story" as AND — returns 0. Search each tag and merge.
    const [storyHits, commentHits] = await Promise.all([
      algoliaSearch(query, 'story', hitsPerPage),
      algoliaSearch(query, 'comment', hitsPerPage),
    ]);

    const seen = new Set();
    const merged = [];
    for (const hit of [...storyHits, ...commentHits]) {
      const id = hit?.objectID;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(hit);
    }

    const items = merged
      .map(normalizeHit)
      .filter((item) => Boolean(item.post_id) && Boolean(item.url));

    return {
      ok: true,
      items,
      meta: { story_count: storyHits.length, comment_count: commentHits.length },
    };
  } catch (err) {
    const message = err.response?.data?.message || err.message || String(err);
    console.error('[hnService] searchHN:', message);
    return {
      ok: false,
      items: [],
      error: { code: 'HN_API_ERROR', message },
    };
  }
}

async function searchHN(query) {
  const result = await searchHNStructured(query);
  return result.ok ? result.items : [];
}

module.exports = {
  searchHN,
  searchHNStructured,
};
