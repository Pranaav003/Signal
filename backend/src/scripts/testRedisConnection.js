require('../config/loadEnv');

const Redis = require('ioredis');
const { REDIS_URL, getIoredisConnectionOptions } = require('../jobs/queueFactory');

if (!REDIS_URL) {
  console.error('REDIS_URL is not set');
  process.exit(1);
}

async function main() {
  const client = new Redis(REDIS_URL, {
    ...getIoredisConnectionOptions(REDIS_URL),
    connectTimeout: 10000,
    lazyConnect: true,
  });

  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') {
      throw new Error(`Unexpected response: ${pong}`);
    }
    console.log('✓ Redis connected');
    console.log('PONG');
  } finally {
    client.disconnect();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('✗ Redis connection failed:', err.message || err);
  process.exit(1);
});
