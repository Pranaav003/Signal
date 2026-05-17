require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const {
  validateRedditCredentials,
  searchRedditStructured,
  searchSubredditStructured,
} = require('../services/redditService');

async function main() {
  console.log('\n=== Reddit public JSON smoke test ===\n');
  console.log('Mode: https://www.reddit.com/.../*.json (no OAuth)\n');

  const auth = await validateRedditCredentials();
  if (!auth.ok) {
    console.error('Reachability: FAILED');
    console.error(' ', auth.error?.message || 'Unknown error');
    process.exit(1);
  }
  console.log(`Reachability: OK (${auth.sample_count ?? 0} sample posts)\n`);

  const globalQ = 'looking for crm software';
  console.log(`searchReddit("${globalQ}")`);
  const global = await searchRedditStructured(globalQ);
  if (!global.ok) {
    console.error('  FAILED:', global.error);
    process.exit(1);
  }
  console.log(`  posts/comments: ${global.items.length}`);

  const subQ = 'recommend accounting software';
  const sub = 'smallbusiness';
  console.log(`\nsearchSubreddit("${sub}", "${subQ}")`);
  const subResult = await searchSubredditStructured(sub, subQ);
  if (!subResult.ok) {
    console.error('  FAILED:', subResult.error);
    process.exit(1);
  }
  console.log(`  posts/comments: ${subResult.items.length}`);

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
