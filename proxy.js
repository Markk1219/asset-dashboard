const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3100;

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

  // FRED proxy: /fred?series=FEDFUNDS&...
  if (req.url.startsWith('/fred')) {
    const qs = req.url.slice('/fred'.length);
    const url = `https://api.stlouisfed.org/fred/series/observations${qs}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(body);
      });
    }).on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

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
  // 先抓文章列表，找最新 Earnings Insight 或 Earnings Season Update
  const listUrl = 'https://insight.factset.com/topic/earnings';
  https.get(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } }, r => {
    let html = '';
    r.on('data', c => html += c);
    r.on('end', () => {
      // 找最新 earnings season update 或 earnings insight 文章 URL
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

      // 日期
      const dateM = text.match(/([A-Z][a-z]+ \d+, 202\d)/);
      if (dateM) data.date = dateM[1];

      // 季別（從標題或 Q2 2026 earnings season 抓）
      const qM = text.match(/Q([1-4] 202\d) earnings season/i)
              || text.match(/for Q([1-4] 202\d) to date/i)
              || text.match(/results for Q([1-4] 202\d)/i);
      if (qM) data.quarter = 'Q' + qM[1];

      // 已報告家數 %
      const reptM = text.match(/(\d+)% of the companies in the S&P 500 have reported actual results/i)
                 || text.match(/(\d+)% of S&P 500 companies have reported actual results/i);
      if (reptM) data.metrics.reportingPct = parseInt(reptM[1]);

      // EPS beat %
      const epsM = text.match(/(\d+)% have reported actual EPS above estimates/i)
                || text.match(/(\d+)% of S&P 500 companies have reported a positive EPS surprise/i);
      if (epsM) data.metrics.epsSurprisePct = parseInt(epsM[1]);

      // EPS 驚喜幅度 %
      const epsMagM = text.match(/companies are reporting earnings that are ([\d.]+)% above estimates/i);
      if (epsMagM) data.metrics.epsSurpiseMag = parseFloat(epsMagM[1]);

      // 營收 beat %
      const revM = text.match(/(\d+)% of S&P 500 companies have reported actual revenues above estimates/i)
                || text.match(/(\d+)% of S&P 500 companies have reported a positive revenue surprise/i);
      if (revM) data.metrics.revSurprisePct = parseInt(revM[1]);

      // Blended 盈餘成長率
      const growthM = text.match(/earnings growth rate for the second quarter is ([\d.]+)% today/i)
                   || text.match(/blended[^.]{0,80}earnings growth rate[^.]{0,30}is ([\d.]+)%/i);
      if (growthM) data.metrics.earningsGrowth = parseFloat(growthM[1]);

      // 營收成長率
      const revGrowthM = text.match(/blended revenue growth rate for the second quarter is ([\d.]+)%/i)
                      || text.match(/blended[^.]{0,60}revenue growth rate[^.]{0,30}is ([\d.]+)%/i);
      if (revGrowthM) data.metrics.revenueGrowth = parseFloat(revGrowthM[1]);

      // Q3/Q4 前瞻
      const q3M = text.match(/Q3 202\d[^%]{0,60}earnings growth[^%]{0,30}([\d.]+)%/i);
      const q4M = text.match(/Q4 202\d[^%]{0,60}earnings growth[^%]{0,30}([\d.]+)%/i);
      if (q3M) data.metrics.q3GrowthEst = parseFloat(q3M[1]);
      if (q4M) data.metrics.q4GrowthEst = parseFloat(q4M[1]);

      // CY 全年預估
      const cyM = text.match(/CY 202\d[^%]{0,60}earnings growth of ([\d.]+)%/i);
      if (cyM) data.metrics.cyGrowthEst = parseFloat(cyM[1]);

      // Forward P/E
      const peM = text.match(/forward 12-month P\/E ratio is ([\d.]+)/i);
      if (peM) data.metrics.forwardPE = parseFloat(peM[1]);

      // P/E 均值
      const pe5M = text.match(/5-year average \(([\d.]+)\)/i);
      const pe10M = text.match(/10-year average \(([\d.]+)\)/i);
      if (pe5M) data.metrics.pe5YrAvg = parseFloat(pe5M[1]);
      if (pe10M) data.metrics.pe10YrAvg = parseFloat(pe10M[1]);

      // guidance（週報格式）
      const negGM = text.match(/(\d+) S&P 500 companies have issued negative EPS guidance/i);
      const posGM = text.match(/(\d+) S&P 500 companies have issued positive EPS guidance/i);
      if (negGM) data.metrics.negGuidance = parseInt(negGM[1]);
      if (posGM) data.metrics.posGuidance = parseInt(posGM[1]);

      // 標題
      const titleM = html.match(/<title>([^<]+)<\/title>/);
      if (titleM) data.title = titleM[1].replace(' | FactSet Insight', '').replace(/&amp;/g, '&').trim();

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(data));
    });
  }).on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
}
