require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const {
  validateRedditCredentials,
  searchRedditStructured,
  searchSubredditStructured,
  searchRedditPublicStructured,
  searchRedditOAuthStructured,
  oauthCredentialsPresent,
  getActiveRedditMode,
  resolveRedditMode,
} = require('../services/redditService');

async function main() {
  console.log('\n=== Reddit API smoke test ===\n');
  console.log('REDDIT_MODE (resolved):', resolveRedditMode());
  console.log('Active mode (worker will use):', getActiveRedditMode());
  console.log('OAuth credentials present:', oauthCredentialsPresent());
  console.log('REDDIT_USER_AGENT set:', Boolean(process.env.REDDIT_USER_AGENT));

  const auth = await validateRedditCredentials();
  if (!auth.ok) {
    console.error('\nReachability: FAILED');
    console.error(' ', auth.error?.message || 'Unknown error');
    process.exit(1);
  }
  console.log(`\nReachability (${auth.mode}): OK (${auth.sample_count ?? 0} sample items)`);
  if (auth.meta) {
    console.log(`  posts: ${auth.meta.post_count ?? '?'} comments: ${auth.meta.comment_count ?? '?'}`);
  }

  const globalQ = 'looking for crm software';
  console.log(`\nsearchRedditStructured("${globalQ}") [${getActiveRedditMode()}]`);
  const global = await searchRedditStructured(globalQ);
  if (!global.ok) {
    console.error('  FAILED:', global.error);
    process.exit(1);
  }
  console.log(`  items: ${global.items.length} (posts: ${global.meta?.post_count ?? 0}, comments: ${global.meta?.comment_count ?? 0})`);

  console.log(`\nsearchRedditPublicStructured("${globalQ}")`);
  const pub = await searchRedditPublicStructured(globalQ);
  console.log(
    pub.ok
      ? `  items: ${pub.items.length} (posts: ${pub.meta?.post_count ?? 0}, comments: ${pub.meta?.comment_count ?? 0})`
      : `  FAILED: ${pub.error?.message}`
  );

  if (oauthCredentialsPresent()) {
    console.log(`\nsearchRedditOAuthStructured("${globalQ}")`);
    const oauth = await searchRedditOAuthStructured(globalQ);
    console.log(
      oauth.ok
        ? `  items: ${oauth.items.length} (posts: ${oauth.meta?.post_count ?? 0}, comments: ${oauth.meta?.comment_count ?? 0})`
        : `  FAILED: ${oauth.error?.message}`
    );
    if (pub.ok && oauth.ok) {
      const diff = oauth.items.length - pub.items.length;
      console.log(
        diff >= 0
          ? `  OAuth returned ${diff} more items than public JSON for this query.`
          : `  Public JSON returned ${-diff} more items than OAuth for this query.`
      );
    }
  } else {
    console.log('\nOAuth sample: skipped (no REDDIT_CLIENT_ID/SECRET/USER_AGENT)');
  }

  const subQ = 'recommend accounting software';
  const sub = 'smallbusiness';
  console.log(`\nsearchSubredditStructured("${sub}", "${subQ}") [${getActiveRedditMode()}]`);
  const subResult = await searchSubredditStructured(sub, subQ);
  if (!subResult.ok) {
    console.error('  FAILED:', subResult.error);
    process.exit(1);
  }
  console.log(
    `  items: ${subResult.items.length} (posts: ${subResult.meta?.post_count ?? 0}, comments: ${subResult.meta?.comment_count ?? 0})`
  );

  const sample = [...global.items, ...subResult.items].slice(0, 3);
  console.log('\nSample normalized results:');
  for (const r of sample) {
    console.log('---');
    console.log('  post_id:', r.post_id);
    console.log('  subreddit:', r.subreddit);
    console.log('  title:', (r.title || r.body_snippet || '').slice(0, 100));
    console.log('  url:', r.url);
  }

  console.log('\nDone.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
