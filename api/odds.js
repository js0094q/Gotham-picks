// api/odds.js
// Serverless proxy that (a) hides your Odds API key, (b) filters to NY-licensed books,
// and (c) caches responses for a short time to reduce rate-limit pain.

const NY_BOOK_TITLES = new Set([
  'DraftKings',
  'FanDuel',
  'BetMGM',
  'Caesars',
  'BetRivers',
  'Resorts World Bet'
]);

// simple in-memory cache (lives as long as the lambda stays warm)
const _mem = new Map();
// default TTL in seconds
const DEFAULT_TTL = 60;

function cacheKey(path, query) {
  // build a stable key from the handler path + normalized query
  const q = { ...query };
  // don’t include irrelevant / dangerous params
  delete q.apiKey;
  return `${path}?${JSON.stringify(q)}`;
}

function setCachingHeaders(res, ttl = DEFAULT_TTL) {
  // cache at Vercel's CDN
  res.setHeader('Cache-Control', `s-maxage=${ttl}, stale-while-revalidate=${Math.round(ttl/2)}`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // optional CORS if you’ll ever embed this elsewhere:
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function filterToNY(json) {
  // json is an array of events
  return (Array.isArray(json) ? json : []).map(evt => {
    const books = (evt.bookmakers || []).filter(bm => NY_BOOK_TITLES.has(bm.title));
    return { ...evt, bookmakers: books };
  }).filter(evt => (evt.bookmakers || []).length > 0); // drop events with no NY books
}

export default async function handler(req, res) {
  try {
    const {
      sport = 'americanfootball_nfl',
      regions = 'us',
      markets = 'h2h,spreads,totals',
      oddsFormat = 'american',
      ttl // optional ?ttl=120 to override cache seconds
    } = req.query || {};

    const TTL = Math.max(10, Number(ttl || DEFAULT_TTL) | 0);
    const key = cacheKey('odds', { sport, regions, markets, oddsFormat });

    // serve warm cache if fresh
    const hit = _mem.get(key);
    if (hit && (Date.now() - hit.ts) / 1000 < TTL) {
      setCachingHeaders(res, TTL);
      return res.status(hit.status).send(hit.body);
    }

    const upstream = `https://api.the-odds-api.com/v4/sports/${sport}/odds` +
      `?regions=${encodeURIComponent(regions)}` +
      `&markets=${encodeURIComponent(markets)}` +
      `&oddsFormat=${encodeURIComponent(oddsFormat)}` +
      `&apiKey=${encodeURIComponent(process.env.ODDS_API_KEY)}`;

    const r = await fetch(upstream, { headers: { accept: 'application/json' } });
    const status = r.status;
    const text = await r.text();

    // If upstream returned JSON, filter it; otherwise pass through error text
    let body = text;
    if (status >= 200 && status < 300) {
      const data = JSON.parse(text);
      body = JSON.stringify(filterToNY(data));
    }

    // store in memory (even if error, to avoid hammering)
    _mem.set(key, { ts: Date.now(), status, body });

    setCachingHeaders(res, TTL);
    return res.status(status).send(body);
  } catch (err) {
    console.error(err);
    setCachingHeaders(res, 10);
    return res.status(500).json({ error: 'Proxy error' });
  }
}

