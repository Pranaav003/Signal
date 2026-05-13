const axios = require('axios');

/**
 * @param {string} raw
 * @returns {{ subreddit: string, postId: string, fullCommentId: string } | null}
 */
function parseRedditCommentUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }

  const hn = u.hostname.replace(/^www\./, '').toLowerCase();
  if (hn !== 'reddit.com' && !hn.endsWith('.reddit.com')) return null;

  const path = u.pathname.replace(/\/+$/, '') || u.pathname;
  const parts = path.split('/').filter(Boolean);
  const rIdx = parts.indexOf('r');
  if (rIdx === -1) return null;

  const sub = parts[rIdx + 1];
  if (!sub || parts[rIdx + 2] !== 'comments') return null;

  const postId = parts[rIdx + 3];
  if (!postId) return null;

  const qComment = u.searchParams.get('comment');
  if (qComment) {
    let id = qComment.trim();
    if (!id.startsWith('t1_')) id = `t1_${id}`;
    return { subreddit: sub, postId, fullCommentId: id };
  }

  /**
   * Post-only URLs look like: /r/sub/comments/postId/title_slug/ (5 segments after /r/…)
   * A comment permalink needs the comment id after the slug:
   * /r/sub/comments/postId/title_slug/commentId/
   * So we require at least 6 segments from index rIdx (r, sub, comments, post, slug, comment).
   */
  if (parts.length < rIdx + 6) return null;

  const last = parts[parts.length - 1];
  if (!last || last === postId) return null;

  const fullCommentId = last.startsWith('t1_') ? last : `t1_${last}`;
  return { subreddit: sub, postId, fullCommentId };
}

function countDirectReplies(commentData) {
  const rep = commentData?.replies;
  if (!rep || rep === '' || !rep.data || !Array.isArray(rep.data.children)) return 0;

  let n = 0;
  for (const ch of rep.data.children) {
    if (ch && ch.kind === 't1') n += 1;
  }
  return n;
}

function walkFindComment(children, fullName) {
  if (!Array.isArray(children)) return null;

  for (const item of children) {
    if (!item || item.kind === 'more') continue;

    if (item.kind === 't1') {
      if (item.data?.name === fullName) return item.data;

      const rep = item.data?.replies;
      if (rep && rep !== '' && rep.data?.children) {
        const found = walkFindComment(rep.data.children, fullName);
        if (found) return found;
      }
    }
  }

  return null;
}

function commentStatusFromData(data) {
  const body = String(data?.body ?? '');
  const author = String(data?.author ?? '');

  if (body === '[removed]') return 'removed';
  if (body === '[deleted]' || author === '[deleted]') return 'deleted';
  return 'active';
}

/**
 * @param {string} commentUrl
 * @returns {Promise<{ upvotes: number, reply_count: number, thread_upvotes: number, thread_reply_count: number, status: string } | null>}
 */
async function getCommentStats(commentUrl) {
  const parsed = parseRedditCommentUrl(commentUrl);
  if (!parsed) return null;

  const { subreddit, postId, fullCommentId } = parsed;

  try {
    const url = `https://www.reddit.com/r/${encodeURIComponent(
      subreddit
    )}/comments/${encodeURIComponent(postId)}.json`;

    const { data } = await axios.get(url, {
      params: {
        comment: fullCommentId,
        limit: 500,
        raw_json: 1,
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Signal/1.0)',
        Accept: 'application/json',
      },
    });

    if (!Array.isArray(data) || data.length < 2) return null;

    const postWrap = data[0]?.data?.children?.[0];
    if (!postWrap || postWrap.kind !== 't3' || !postWrap.data) return null;
    const postListing = postWrap.data;

    const threadUpvotes = Number(postListing.ups ?? 0);
    const threadReplyCount = Number(postListing.num_comments ?? 0);

    const roots = data[1]?.data?.children;
    const commentData = walkFindComment(roots, fullCommentId);
    if (!commentData) return null;

    const upvotes = Number(commentData.ups ?? 0);
    const replyCount = countDirectReplies(commentData);
    const status = commentStatusFromData(commentData);

    return {
      upvotes,
      reply_count: replyCount,
      thread_upvotes: threadUpvotes,
      thread_reply_count: threadReplyCount,
      status,
    };
  } catch (err) {
    console.error(
      '[redditTracker] getCommentStats:',
      err.response?.data || err.message || err
    );
    return null;
  }
}

module.exports = {
  getCommentStats,
  parseRedditCommentUrl,
};
