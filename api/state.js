
const { Redis } = require('@upstash/redis');
const seed = require('../data/seed.json');

const STATE_KEY = process.env.TRIP_STATE_KEY || 'bali-trip-board-v1';

function makeRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const redis = makeRedis();
  if (!redis) {
    return res.status(503).json({
      shared: false,
      error: 'Shared storage is not configured.'
    });
  }

  if (req.method === 'GET') {
    let state = await redis.get(STATE_KEY);
    if (!state || !Array.isArray(state.items)) {
      state = { items: seed, updatedAt: new Date().toISOString() };
      await redis.set(STATE_KEY, state);
    }
    return res.status(200).json({ shared: true, ...state });
  }

  if (req.method === 'POST') {
    const requiredKey = process.env.TRIP_EDIT_KEY;
    const suppliedKey = req.headers['x-trip-key'];

    if (!requiredKey || suppliedKey !== requiredKey) {
      return res.status(401).json({ error: 'Invalid edit PIN.' });
    }

    const body = req.body || {};
    if (!Array.isArray(body.items) || body.items.length > 500) {
      return res.status(400).json({ error: 'Invalid trip state.' });
    }

    const state = {
      items: body.items,
      updatedAt: new Date().toISOString()
    };

    await redis.set(STATE_KEY, state);
    return res.status(200).json({ ok: true, updatedAt: state.updatedAt });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
};
