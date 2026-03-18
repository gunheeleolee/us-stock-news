require('dotenv').config({ override: true });
const express = require('express');
const RSSParser = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const parser = new RSSParser();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const IS_VERCEL = process.env.VERCEL === '1';
const CACHE_FILE = 'cache.json';
let memoryCache = [];
let lastFetched = null;
let marketCache = null;
let marketLastFetched = null;

const CACHE_DURATION = 30 * 60 * 1000;
const MARKET_CACHE_DURATION = 5 * 60 * 1000;

const SOURCES = [
  { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
  { name: 'Seeking Alpha', url: 'https://seekingalpha.com/feed.xml' },
  { name: 'Benzinga', url: 'https://www.benzinga.com/feed' },
];

// 로컬에서만 파일 캐시 불러오기
if (!IS_VERCEL && fs.existsSync(CACHE_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    memoryCache = saved.cache || [];
    lastFetched = saved.lastFetched || null;
    console.log(`파일 캐시 불러옴 (${memoryCache.length}개 기사)`);
  } catch (e) {
    console.log('파일 캐시 불러오기 실패');
  }
}

async function fetchMarketData() {
  const now = Date.now();
  if (marketLastFetched && now - marketLastFetched < MARKET_CACHE_DURATION && marketCache) {
    return marketCache;
  }
  try {
    // 주요 지수 + 대형 기술주
    const symbols = [
      '^GSPC', '^IXIC', '^DJI',
      'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA', 'META'
    ];
    const query = symbols.join(',');
    const response = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(query)}&range=1d&interval=1d`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      }
    );

    const data = response.data;
    const SYMBOL_NAMES = { '^GSPC': 'S&P 500', '^IXIC': 'NASDAQ', '^DJI': 'DOW' };
    marketCache = symbols.map(sym => {
      const info = data[sym];
      if (!info) return null;
      const close = info.close?.[info.close.length - 1];
      const prevClose = info.chartPreviousClose;
      const change = prevClose ? ((close - prevClose) / prevClose * 100) : 0;
      return {
        symbol: SYMBOL_NAMES[sym] || sym,
        price: close,
        change,
        isIndex: sym.startsWith('^')
      };
    }).filter(Boolean);
    marketLastFetched = now;
    return marketCache;
  } catch (e) {
    console.log('시장 데이터 가져오기 실패:', e.message);
    return [];
  }
}

async function fetchFearGreed() {
  try {
    const response = await axios.get('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    const data = response.data?.fear_and_greed;
    if (data) {
      return {
        value: Math.round(data.score),
        classification: data.rating
      };
    }
    return null;
  } catch (e) {
    console.log('Fear & Greed 가져오기 실패:', e.message);
    return null;
  }
}

async function generateMarketAnalysis(news, fearGreed) {
  const signalCount = {
    긍정: news.filter(n => n.signal === '긍정').length,
    부정: news.filter(n => n.signal === '부정').length,
    중립: news.filter(n => n.signal === '중립').length
  };

  const topNews = news.slice(0, 5).map((n, i) =>
    `${i + 1}. [${n.signal}] ${n.koreanTitle}`
  ).join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `아래 데이터를 기반으로 미국 주식 시장 단기 방향성을 분석해줘.

공포탐욕지수: ${fearGreed?.value || '알 수 없음'} (${fearGreed?.classification || ''})
뉴스 시그널: 긍정 ${signalCount.긍정}건, 부정 ${signalCount.부정}건, 중립 ${signalCount.중립}건
주요 뉴스:
${topNews}

아래 형식으로만 출력해줘:
방향성: (강한상승 또는 약한상승 또는 중립 또는 약한하락 또는 강한하락 중 하나)
분석: (2~3문장으로 핵심만. 왜 이런 방향성인지 근거 포함)
주목변수: (오늘 가장 주목해야 할 변수 한 줄)`
    }]
  });
  return message.content[0].text;
}

async function translateSummarizeAndScore(title, content) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `아래 영어 기사를 한국어로 처리하고 분석해줘.

제목: ${title}
본문: ${content}

아래 형식으로만 출력해줘:
번역제목: (제목을 자연스러운 한국어로 번역)
요약: (본문을 한국어로 5문장 내외로 요약. 핵심 내용을 충실하게 담아줘)
중요도: (1~5 숫자만. 기준: 5=연준 정책/규제 변화/시장 전체 영향, 4=대형 실적발표/M&A/주요 기관 동향, 3=섹터 트렌드/일반 시장 동향, 2=개별 종목/특정 기업 뉴스, 1=단순 정보/오피니언)
시그널: (긍정 또는 부정 또는 중립 중 하나만)
태그: (기사에서 언급된 종목 티커 또는 섹터. 예: AAPL,NVDA,기술주 / 없으면 없음)`
    }]
  });
  return message.content[0].text;
}

async function fetchAllNews() {
  const now = Date.now();

  // 메모리 캐시가 유효하면 바로 반환
  if (lastFetched && now - lastFetched < CACHE_DURATION && memoryCache.length > 0) {
    console.log('메모리 캐시 사용');
    return memoryCache;
  }

  console.log('새 데이터 확인 중...');

  // Supabase에서 기존 기사 URL 목록 가져오기
  const { data: existingArticles } = await supabase
    .from('articles')
    .select('url');

  const existingUrls = new Set((existingArticles || []).map(a => a.url));

  const newItems = [];

  for (const source of SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      const items = feed.items.slice(0, 5);

      for (const item of items) {
        if (existingUrls.has(item.link)) {
          console.log(`건너뜀 (DB에 있음): ${item.title}`);
          continue;
        }

        const content = item.contentSnippet || item.content || '';
        if (!content || content.trim().length < 50) {
          console.log(`건너뜀 (본문 없음): ${item.title}`);
          continue;
        }

        console.log(`번역 중: ${item.title}`);
        const result = await translateSummarizeAndScore(item.title, content);
        console.log(`번역 완료: ${item.title}`);

        const lines = result.split('\n').filter(l => l.trim());
        const koreanTitle = lines.find(l => l.startsWith('번역제목:'))?.replace('번역제목:', '').trim();
        const summary = lines.find(l => l.startsWith('요약:'))?.replace('요약:', '').trim();
        const scoreText = lines.find(l => l.startsWith('중요도:'))?.replace('중요도:', '').trim();
        const signal = lines.find(l => l.startsWith('시그널:'))?.replace('시그널:', '').trim();
        const tagText = lines.find(l => l.startsWith('태그:'))?.replace('태그:', '').trim();
        const tags = tagText && tagText !== '없음' ? tagText.split(',').map(t => t.trim()) : [];
        const score = parseInt(scoreText) || 3;

        const newArticle = {
          url: item.link,
          original_title: item.title,
          korean_title: koreanTitle,
          summary,
          source: source.name,
          score,
          signal,
          tags,
          pub_date: item.pubDate
        };

        // Supabase DB에 저장
        await supabase.from('articles').insert(newArticle);
        console.log(`DB 저장 완료: ${item.title}`);

        newItems.push({
          originalTitle: item.title,
          koreanTitle,
          summary,
          link: item.link,
          date: item.pubDate,
          source: source.name,
          score,
          signal,
          tags
        });
      }
    } catch (e) {
      console.log(`${source.name} RSS 가져오기 실패:`, e.message);
    }
  }

  // Supabase에서 전체 기사 불러오기
  const { data: allArticles } = await supabase
    .from('articles')
    .select('*')
    .order('score', { ascending: false })
    .order('pub_date', { ascending: false })
    .limit(50);

  memoryCache = (allArticles || []).map(a => ({
    originalTitle: a.original_title,
    koreanTitle: a.korean_title,
    summary: a.summary,
    link: a.url,
    date: a.pub_date,
    source: a.source,
    score: a.score,
    signal: a.signal,
    tags: a.tags || []
  }));

  lastFetched = now;

  // 로컬에서만 파일 캐시 저장
  if (!IS_VERCEL) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ cache: memoryCache, lastFetched }));
    console.log(`파일 캐시 저장 완료`);
  }

  return memoryCache;
}

async function generateDailyBrief(news) {
  const today = new Date().toISOString().split('T')[0];

  // 새 기사가 추가됐는지 확인
  const { data: existing } = await supabase
    .from('briefs')
    .select('*')
    .eq('brief_date', today)
    .single();

  const latestArticleTime = news[0]?.date ? new Date(news[0].date).getTime() : 0;
  const briefCreatedTime = existing ? new Date(existing.created_at).getTime() : 0;

  if (existing && briefCreatedTime > latestArticleTime) {
    console.log('브리핑 DB 캐시 사용 (최신 상태)');
    return { briefText: existing.brief_text, picks: existing.picks };
  }

  console.log('브리핑 새로 생성 중... (새 기사 반영)');
  const top5 = news.slice(0, 5);
  const articleSummaries = top5.map((item, i) =>
    `${i + 1}. ${item.koreanTitle} (${item.source}, ${item.signal})`
  ).join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `아래는 오늘의 주요 미국 주식 뉴스야.

${articleSummaries}

아래 형식으로만 출력해줘:
브리핑: (오늘 미국 주식 시장 전반을 3~4문장으로 핵심만 요약. 날카롭고 임팩트 있게)
픽1: (꼭 읽어야 할 기사 제목 1개)
픽2: (꼭 읽어야 할 기사 제목 1개)
픽3: (꼭 읽어야 할 기사 제목 1개)`
    }]
  });

  const brief = message.content[0].text;
  const briefLines = brief.split('\n').filter(l => l.trim());
  const briefText = briefLines.find(l => l.startsWith('브리핑:'))?.replace('브리핑:', '').trim();
  const pick1 = briefLines.find(l => l.startsWith('픽1:'))?.replace('픽1:', '').trim();
  const pick2 = briefLines.find(l => l.startsWith('픽2:'))?.replace('픽2:', '').trim();
  const pick3 = briefLines.find(l => l.startsWith('픽3:'))?.replace('픽3:', '').trim();
  const picks = [pick1, pick2, pick3].filter(Boolean);

  // 오늘 브리핑 DB에 저장 (기존 브리핑 있으면 업데이트)
  await supabase.from('briefs').upsert({
    brief_date: today,
    brief_text: briefText,
    picks,
    created_at: new Date().toISOString()
  }, { onConflict: 'brief_date' });
  console.log('브리핑 DB 저장 완료');

  return { briefText, picks };
}

// SEC 내부자 거래 (Form 4)
const INSIDER_CACHE_DURATION = 30 * 60 * 1000;
let insiderCache = null;
let insiderLastFetched = null;

const TRACKED_CIKS = {
  '0000320193': 'AAPL', '0000789019': 'MSFT', '0001045810': 'NVDA',
  '0001652044': 'GOOGL', '0001018724': 'AMZN', '0001318605': 'TSLA',
  '0001326801': 'META'
};

async function fetchInsiderTrades() {
  const now = Date.now();
  if (insiderLastFetched && now - insiderLastFetched < INSIDER_CACHE_DURATION && insiderCache) {
    return insiderCache;
  }

  try {
    // 최근 30일간 추적 종목의 Form 4 조회
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const cikQuery = Object.keys(TRACKED_CIKS).map(c => `"${c}"`).join(' OR ');

    const response = await axios.get(
      `https://efts.sec.gov/LATEST/search-index?forms=4&dateRange=custom&startdt=${startDate}&enddt=${endDate}&q=${encodeURIComponent(cikQuery)}`,
      { headers: { 'User-Agent': 'USStockNews contact@example.com' } }
    );

    const filings = response.data?.hits?.hits || [];
    const trades = [];

    // 상위 10건만 XML 파싱
    for (const filing of filings.slice(0, 10)) {
      try {
        const src = filing._source;
        const companyCik = src.ciks.find(c => TRACKED_CIKS[c]);
        if (!companyCik) continue;

        const ticker = TRACKED_CIKS[companyCik];
        const adsh = src.adsh;
        const cikNum = companyCik.replace(/^0+/, '');

        // filing index에서 XML 파일명 찾기
        const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${adsh.replace(/-/g, '')}/index.json`;
        const indexRes = await axios.get(indexUrl, {
          headers: { 'User-Agent': 'USStockNews contact@example.com' }
        });
        const xmlFile = indexRes.data.directory.item.find(i => i.name.endsWith('.xml') && i.name !== 'primary_doc.xml');
        if (!xmlFile) continue;

        const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${adsh.replace(/-/g, '')}/${xmlFile.name}`;
        const xmlRes = await axios.get(xmlUrl, {
          headers: { 'User-Agent': 'USStockNews contact@example.com' }
        });
        const xml = xmlRes.data;

        // 간단한 XML 파싱
        const ownerName = xml.match(/<rptOwnerName>(.*?)<\/rptOwnerName>/)?.[1] || '';
        const officerTitle = xml.match(/<officerTitle>(.*?)<\/officerTitle>/)?.[1] || '';
        const isDirector = xml.includes('<isDirector>1</isDirector>');
        const transCode = xml.match(/<transactionCode>(.*?)<\/transactionCode>/)?.[1] || '';
        const shares = xml.match(/<transactionShares>\s*<value>(.*?)<\/value>/)?.[1] || '';
        const pricePerShare = xml.match(/<transactionPricePerShare>\s*<value>(.*?)<\/value>/)?.[1] || '';
        const acquiredDisposed = xml.match(/<transactionAcquiredDisposedCode>\s*<value>(.*?)<\/value>/)?.[1] || '';

        const isBuy = acquiredDisposed === 'A';
        const totalValue = shares && pricePerShare ? (parseFloat(shares) * parseFloat(pricePerShare)) : 0;

        trades.push({
          ticker,
          owner: ownerName,
          title: officerTitle || (isDirector ? 'Director' : 'Insider'),
          type: isBuy ? '매수' : '매도',
          shares: parseInt(shares) || 0,
          price: parseFloat(pricePerShare) || 0,
          totalValue: Math.round(totalValue),
          date: src.file_date,
          transCode
        });
      } catch (e) {
        // 개별 파일링 파싱 실패는 무시
      }
    }

    // $0 거래(스톡옵션 행사 등) 제외, 금액 큰 순으로 정렬
    insiderCache = trades.filter(t => t.totalValue > 0).sort((a, b) => b.totalValue - a.totalValue);
    insiderLastFetched = now;
    return insiderCache;
  } catch (e) {
    console.log('내부자 거래 가져오기 실패:', e.message);
    return [];
  }
}

app.get('/api/insider', async (req, res) => {
  const trades = await fetchInsiderTrades();
  res.json(trades);
});

app.get('/api/news', async (req, res) => {
  const news = await fetchAllNews();
  res.json(news);
});

app.get('/api/market', async (req, res) => {
  const [market, fearGreed] = await Promise.all([fetchMarketData(), fetchFearGreed()]);
  res.json({ market, fearGreed });
});

app.get('/api/analysis', async (req, res) => {
  const [news, fearGreed] = await Promise.all([fetchAllNews(), fetchFearGreed()]);
  const analysis = await generateMarketAnalysis(news, fearGreed);

  const lines = analysis.split('\n').filter(l => l.trim());
  const direction = lines.find(l => l.startsWith('방향성:'))?.replace('방향성:', '').trim();
  const comment = lines.find(l => l.startsWith('분석:'))?.replace('분석:', '').trim();
  const watchout = lines.find(l => l.startsWith('주목변수:'))?.replace('주목변수:', '').trim();

  res.json({ direction, comment, watchout });
});

app.get('/api/brief', async (req, res) => {
  const news = await fetchAllNews();
  const { briefText, picks } = await generateDailyBrief(news);
  res.json({ briefText, picks });
});

async function autoRefresh() {
  console.log('자동 새로고침 시작...');
  lastFetched = null;
  await fetchAllNews();
  console.log('자동 새로고침 완료');
}

if (!IS_VERCEL) {
  app.listen(3000, async () => {
    console.log('서버 실행 중 → http://localhost:3000');
    await fetchAllNews();
    setInterval(autoRefresh, CACHE_DURATION);
  });
}

module.exports = app;
