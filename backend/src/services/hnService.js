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
    subreddit: 'HackerNews',
    created_utc: hit.created_at_i || null,
    type: hit.comment_text ? 'comment' : 'post',
    platform: 'hackernews',
  };
}

async function searchHN(query) {
  try {
    const { data } = await axios.get('https://hn.algolia.com/api/v1/search', {
      params: {
        query,
        tags: 'comment,story',
        hitsPerPage: 20,
      },
      headers: {
        Accept: 'application/json',
      },
    });

    const hits = data?.hits || [];
    return hits
      .map(normalizeHit)
      .filter((item) => Boolean(item.post_id) && Boolean(item.url));
  } catch (err) {
    console.error('[hnService] searchHN:', err.response?.data || err.message || err);
    return [];
  }
}

module.exports = {
  searchHN,
};

