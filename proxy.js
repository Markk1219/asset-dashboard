const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3100;
const FRED_KEY = '10b4c30bbf29d1ba7a1b29d797ffecea';

// ── FRED 快取（規避 Render IP 被封鎖問題）────────────────────────────
// 啟動時預抓，之後每小時更新，瀏覽器直接拿快取
const FRED_SERIES = [
  'FEDFUNDS', 'CPIAUCSL', 'PCEPI', 'UNRATE',
  'DFEDTARU', 'DFEDTARL', 'BAMLH0A0HYM2', 'BAMLC0A0CM',
];
const fredCache = {};   // { series: { data, updatedAt } }

function fetchFredSeries(series, limit) {
  return new Promise((resolve) => {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${FRED_KEY}&sort_order=desc&limit=${limit}&file_type=json`;
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => resolve(body));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function refreshFredCache() {
  console.log('[FRED] refreshing cache...');
  for (const series of FRED_SERIES) {
    const limit = ['CPIAUCSL', 'PCEPI'].includes(series) ? 14 : 2;
    const body = await fetchFredSeries(series, limit);
    if (body) {
      fredCache[series] = { data: body, updatedAt: Date.now() };
      console.log(`[FRED] cached ${series}`);
    } else {
      console.log(`[FRED] failed ${series}`);
    }
  }
}

// 啟動時抓一次，之後每小時更新
refreshFredCache();
setInterval(refreshFredCache, 60 * 60 * 1000);

// ── HTTP Server ───────────────────────────────────────────────────────
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  // FactSet Earnings Insight proxy: /factset
  if (req.url === '/factset') {
    fetchFactSet(res);
    return;
  }

  // FRED proxy: /fred?series_id=FEDFUNDS&...  → 從快取回應
  if (req.url.startsWith('/fred')) {
    const params = new URLSearchParams(req.url.slice('/fred?'.length));
    const series = params.get('series_id');
    res.setHeader('Content-Type', 'application/json');
    if (series && fredCache[series]) {
      res.writeHead(200);
      res.end(fredCache[series].data);
    } else if (series) {
      // 快取還沒建立，即時抓（可能失敗）
      const limit = parseInt(params.get('limit') || '2');
      fetchFredSeries(series, limit).then(body => {
        if (body) {
          fredCache[series] = { data: body, updatedAt: Date.now() };
          res.writeHead(200); res.end(body);
        } else {
          res.writeHead(504); res.end(JSON.stringify({ error: 'FRED unavailable' }));
        }
      });
    } else {
      res.writeHead(400); res.end(JSON.stringify({ error: 'missing series_id' }));
    }
    return;
  }

  // Yahoo Finance
  const symbol = decodeURIComponent(req.url.replace('/', '').split('?')[0]);
  if (!symbol) { res.writeHead(400); res.end('missing symbol'); return; }

  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0' } };

  https.get(url, opts, r => {
    let body = '';
    r.on('data', c => body += c);
    r.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(body);
    });
  }).on('error', e => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  });
}).listen(PORT, () => console.log(`Proxy running on port ${PORT}`));

// ── FactSet Earnings Insight 抓取與解析 ──────────────────────────
function fetchFactSet(res) {
  const listUrl = 'https://insight.factset.com/topic/earnings';
  https.get(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } }, r => {
    let html = '';
    r.on('data', c => html += c);
    r.on('end', () => {
      const patterns = [
        /href="(https:\/\/insight\.factset\.com\/sp-500-earnings-season-update[^"]+)"/,
        /href="(https:\/\/insight\.factset\.com\/sp-500-[^"]*earnings[^"]+)"/,
      ];
      let articleUrl = null;
      for (const pat of patterns) {
        const m = html.match(pat);
        if (m) { articleUrl = m[1]; break; }
      }
      if (!articleUrl) {
        res.writeHead(200);
        res.end(JSON.stringify({ error: '找不到最新文章' }));
        return;
      }
      fetchFactSetArticle(articleUrl, res);
    });
  }).on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
}

function fetchFactSetArticle(url, res) {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } }, r => {
    let html = '';
    r.on('data', c => html += c);
    r.on('end', () => {
      const text = html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
      const data = { url, date: '', quarter: '', metrics: {} };

      const dateM = text.match(/([A-Z][a-z]+ \d+, 202\d)/);
      if (dateM) data.date = dateM[1];

      const qM = text.match(/Q([1-4] 202\d) earnings season/i)
              || text.match(/for Q([1-4] 202\d) to date/i)
              || text.match(/results for Q([1-4] 202\d)/i);
      if (qM) data.quarter = 'Q' + qM[1];

      const reptM = text.match(/(\d+)% of the companies in the S&P 500 have reported actual results/i)
                 || text.match(/(\d+)% of S&P 500 companies have reported actual results/i);
      if (reptM) data.metrics.reportingPct = parseInt(reptM[1]);

      const epsM = text.match(/(\d+)% have reported actual EPS above estimates/i)
                || text.match(/(\d+)% of S&P 500 companies have reported a positive EPS surprise/i);
      if (epsM) data.metrics.epsSurprisePct = parseInt(epsM[1]);

      const epsMagM = text.match(/companies are reporting earnings that are ([\d.]+)% above estimates/i);
      if (epsMagM) data.metrics.epsSurpiseMag = parseFloat(epsMagM[1]);

      const revM = text.match(/(\d+)% of S&P 500 companies have reported actual revenues above estimates/i)
                || text.match(/(\d+)% of S&P 500 companies have reported a positive revenue surprise/i);
      if (revM) data.metrics.revSurprisePct = parseInt(revM[1]);

      const growthM = text.match(/earnings growth rate for the second quarter is ([\d.]+)% today/i)
                   || text.match(/blended[^.]{0,80}earnings growth rate[^.]{0,30}is ([\d.]+)%/i);
      if (growthM) data.metrics.earningsGrowth = parseFloat(growthM[1]);

      const revGrowthM = text.match(/blended revenue growth rate for the second quarter is ([\d.]+)%/i)
                      || text.match(/blended[^.]{0,60}revenue growth rate[^.]{0,30}is ([\d.]+)%/i);
      if (revGrowthM) data.metrics.revenueGrowth = parseFloat(revGrowthM[1]);

      const q3M = text.match(/Q3 202\d[^%]{0,60}earnings growth[^%]{0,30}([\d.]+)%/i);
      const q4M = text.match(/Q4 202\d[^%]{0,60}earnings growth[^%]{0,30}([\d.]+)%/i);
      if (q3M) data.metrics.q3GrowthEst = parseFloat(q3M[1]);
      if (q4M) data.metrics.q4GrowthEst = parseFloat(q4M[1]);

      const cyM = text.match(/CY 202\d[^%]{0,60}earnings growth of ([\d.]+)%/i);
      if (cyM) data.metrics.cyGrowthEst = parseFloat(cyM[1]);

      const peM = text.match(/forward 12-month P\/E ratio is ([\d.]+)/i);
      if (peM) data.metrics.forwardPE = parseFloat(peM[1]);

      const pe5M = text.match(/5-year average \(([\d.]+)\)/i);
      const pe10M = text.match(/10-year average \(([\d.]+)\)/i);
      if (pe5M) data.metrics.pe5YrAvg = parseFloat(pe5M[1]);
      if (pe10M) data.metrics.pe10YrAvg = parseFloat(pe10M[1]);

      const negGM = text.match(/(\d+) S&P 500 companies have issued negative EPS guidance/i);
      const posGM = text.match(/(\d+) S&P 500 companies have issued positive EPS guidance/i);
      if (negGM) data.metrics.negGuidance = parseInt(negGM[1]);
      if (posGM) data.metrics.posGuidance = parseInt(posGM[1]);

      const titleM = html.match(/<title>([^<]+)<\/title>/);
      if (titleM) data.title = titleM[1].replace(' | FactSet Insight', '').replace(/&amp;/g, '&').trim();

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(data));
    });
  }).on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
}
