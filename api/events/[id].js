// api/events/[id].js
// Serverless proxy for fetching odds for a specific event.

const _mem = new Map();
const DEFAULT_TTL = 60;

function cacheKey(path, query) {
  const q = { ...query };
  delete q.apiKey;
  return `${path}?${JSON.stringify(q)}`;
}

function setCachingHeaders(res, ttl = DEFAULT_TTL) {
  res.setHeader('Cache-Control', `s-maxage=${ttl}, stale-while-revalidate=${Math.round(ttl/2)}`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
}

export default async function handler(req, res) {
  try {
    const { id } = req.query;
    const {
      sport = 'americanfootball_nfl',
      regions = 'us',
      markets = 'player_pass_yds,player_pass_tds,player_rush_yds,player_reception_yds,player_anytime_td',
      oddsFormat = 'american',
      ttl
    } = req.query || {};

    const TTL = Math.max(10, Number(ttl || DEFAULT_TTL) | 0);
    const key = cacheKey(`events/${id}`, { sport, regions, markets, oddsFormat });

    const hit = _mem.get(key);
    if (hit && (Date.now() - hit.ts) / 1000 < TTL) {
      setCachingHeaders(res, TTL);
      return res.status(hit.status).send(hit.body);
    }

    const upstream = `https://api.the-odds-api.com/v4/sports/${sport}/events/${encodeURIComponent(id)}/odds` +
      `?regions=${encodeURIComponent(regions)}` +
      `&markets=${encodeURIComponent(markets)}` +
      `&oddsFormat=${encodeURIComponent(oddsFormat)}` +
      `&apiKey=${encodeURIComponent(process.env.ODDS_API_KEY)}`;

    const r = await fetch(upstream, { headers: { accept: 'application/json' } });
    const status = r.status;
    const text = await r.text();

    let body = text;
    if (status >= 200 && status < 300) {
      const data = JSON.parse(text);
      // The upstream API for a single event returns an OBJECT.
      // To keep our API consistent, we'll wrap it in an array,
      // so the frontend always receives an array of events.
      body = JSON.stringify([data]);
    }

    _mem.set(key, { ts: Date.now(), status, body });

    setCachingHeaders(res, TTL);
    return res.status(status).send(body);
  } catch (err) {
    console.error(err);
    setCachingHeaders(res, 10);
    return res.status(500).json({ error: 'Proxy error' });
  }
}

