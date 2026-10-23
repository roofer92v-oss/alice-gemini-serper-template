
// Alice + Gemini + Serper webhook
// Node.js 22+, без дополнительных библиотек

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

const MAX_ALICE_TEXT = 1024;
const TOTAL_BUDGET_MS = 4000;
const SEARCH_TIMEOUT_MS = 1900;
const GEMINI_TIMEOUT_MS = 3000;

const HISTORY_LIMIT = 4;
const HISTORY_CHARS = 170;

const SYSTEM_PROMPT = [
  'Ты голосовой помощник в навыке Яндекс Алисы.',
  'Отвечай по-русски, естественно и кратко, обычно одним-тремя предложениями.',
  'Не используй Markdown, не выдавай неподтверждённые актуальные сведения.',
  'Если свежих данных нет, честно скажи об этом.'
].join(' ');

function cleanText(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fitAliceText(value) {
  const str = cleanText(value);

  if (!str) return 'Не удалось подготовить ответ.';

  if (str.length <= MAX_ALICE_TEXT) return str;

  const cut = str.slice(0, MAX_ALICE_TEXT - 1);

  const stop = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? ')
  );

  if (stop > 200) {
    return cut.slice(0, stop + 1).trim();
  }

  const lastSpace = cut.lastIndexOf(' ');

  return cut.slice(
    0,
    lastSpace > 100 ? lastSpace : cut.length
  ) + '…';
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(x =>
      x &&
      ['user', 'model'].includes(x.role) &&
      typeof x.text === 'string'
    )
    .slice(-HISTORY_LIMIT)
    .map(x => ({
      role: x.role,
      text: cleanText(x.text).slice(0, HISTORY_CHARS)
    }));
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: '1.0',
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: {
      history: safeHistory(history)
    }
  };
}

function isSearchIntent(text) {
  return /сегодня|сейчас|последн|новост|погод|температур|курс( |$)|доллар|евро|рубл|валют|найди|поищи|в интернете|актуальн|сколько стоит|цена|свеж|расписани|результат матча|latest|today|current|news|weather|exchange rate|search|look up/i.test(text);
}

function isWeather(text) {
  return /погод|температур|осадк|снег|дожд|ветер/i.test(text);
}

function isRate(text) {
  return /курс|доллар|евро|рубл|валют|биткоин|bitcoin/i.test(text);
}

function isNews(text) {
  return /новост|произошл|событи|последн|свеж/i.test(text);
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    Math.max(100, timeoutMs)
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

function formatWebResult(question, data) {
  const box = data?.answerBox || {};
  const kg = data?.knowledgeGraph || {};

  const answer = cleanText(
    box.answer || box.snippet || kg.description || ''
  ).slice(0, 350);

  const organic = (
    Array.isArray(data?.organic) ? data.organic : []
  ).filter(x => x && (x.title || x.snippet));

  // Не придумываем точную погоду и курсы валют
  if (isWeather(question) || isRate(question)) {
    if (answer) {
      return `По результатам поиска: ${answer}`;
    }

    const source = organic[0];

    return source
      ? `Поиск нашёл ${cleanText(source.title).slice(0, 110)}. Точные актуальные данные в ответе поиска не указаны, поэтому не буду угадывать.`
      : '';
  }

  // Новости: короткий ответ из найденных заголовков
  if (isNews(question)) {
    const entries = organic
      .slice(0, 2)
      .map(x =>
        cleanText(x.title || x.snippet).slice(0, 155)
      )
      .filter(Boolean);

    return entries.length
      ? `Нашла в поиске: ${entries.join('. ')}. Это заголовки, детали лучше уточнять в источнике.`
      : answer;
  }

  if (answer) {
    return `По результатам поиска: ${answer}`;
  }

  const entries = organic
    .slice(0, 2)
    .map(x =>
      cleanText(x.snippet || x.title).slice(0, 200)
    )
    .filter(Boolean);

  return entries.length
    ? `По результатам поиска: ${entries.join('. ')}`
    : '';
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;

  if (!key) {
    return { text: '', reason: 'no_key' };
  }

  const start = Date.now();

  try {
    const { response, data } = await fetchJson(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          q: query,
          gl: 'ru',
          hl: 'ru',
          num: 3
        })
      },
      timeoutMs
    );

    console.info(
      'Serper HTTP',
      response.status,
      'elapsed_ms',
      Date.now() - start
    );

    if (!response.ok) {
      return {
        text: '',
        reason: `http_${response.status}`
      };
    }

    return {
      text: formatWebResult(query, data),
      reason: 'ok'
    };
  } catch (error) {
    console.warn(
      'Serper error',
      error?.name || 'Error',
      cleanText(error?.message).slice(0, 120),
      'elapsed_ms',
      Date.now() - start
    );

    return {
      text: '',
      reason: error?.name === 'AbortError'
        ? 'timeout'
        : 'network'
    };
  }
}

async function askGemini(question, history, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error('MISSING_GEMINI_KEY');
  }

  const model = String(
    process.env.GEMINI_MODEL || DEFAULT_MODEL
  ).trim();

  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error('INVALID_MODEL');
  }

  const contents = safeHistory(history).map(x => ({
    role: x.role,
    parts: [{ text: x.text }]
  }));

  contents.push({
    role: 'user',
    parts: [{ text: question }]
  });

  const start = Date.now();

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 180
        }
      })
    },
    timeoutMs
  );

  console.info(
    'Gemini HTTP',
    response.status,
    'elapsed_ms',
    Date.now() - start
  );

  if (!response.ok) {
    throw new Error(`GEMINI_HTTP_${response.status}`);
  }

  const answer = (
    data?.candidates?.[0]?.content?.parts || []
  )
    .map(p => p.text || '')
    .join('')
    .trim();

  if (!answer) {
    throw new Error('GEMINI_EMPTY');
  }

  return answer;
}

function fallback(error) {
  if (error?.message === 'MISSING_GEMINI_KEY') {
    return 'Проверьте переменную GEMINI_API_KEY в Vercel.';
  }

  if (error?.message === 'GEMINI_HTTP_429') {
    return 'Сейчас превышен лимит запросов к нейросети. Попробуйте позже.';
  }

  if (
    error?.message === 'GEMINI_HTTP_401' ||
    error?.message === 'GEMINI_HTTP_403'
  ) {
    return 'Ошибка доступа к Gemini. Проверьте ключ.';
  }

  return 'Не успела получить ответ от нейросети. Попробуйте ещё раз.';
}

async function getCurrencyRate(question) {
  const isUSD = /доллар|usd/i.test(question);
  const isEUR = /евро|eur/i.test(question);

  if (!isUSD && !isEUR) return null;

  const code = isEUR ? 'EUR' : 'USD';
  const name = isEUR ? 'евро' : 'доллар';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1700);

  try {
    const response = await fetch(
      'https://www.cbr.ru/scripts/XML_daily.asp',
      { signal: controller.signal }
    );

    if (!response.ok) throw new Error('CBR_HTTP_' + response.status);

    const xml = await response.text();

    const block = [...xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)]
      .map(x => x[1])
      .find(x => x.includes(`<CharCode>${code}</CharCode>`));

    if (!block) throw new Error('CURRENCY_NOT_FOUND');

    const value = block.match(/<Value>([\d,]+)<\/Value>/)?.[1];
    const nominal = block.match(/<Nominal>(\d+)<\/Nominal>/)?.[1];
    const date = xml.match(/<ValCurs[^>]*Date="([^"]+)"/)?.[1];

    if (!value || !nominal || !date) {
      throw new Error('CBR_INVALID_RESPONSE');
    }

    const rate = Number(value.replace(',', '.')) / Number(nominal);

    if (!Number.isFinite(rate)) throw new Error('INVALID_RATE');

    return `По официальному курсу Центробанка на ${date}, один ${name} стоит ${rate.toFixed(2).replace('.', ',')} рубля.`;
  } catch (error) {
    console.warn('CBR error:', error.name, error.message);
    return 'Не удалось получить актуальный курс Центробанка.';
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  // Проверка доступности сервера
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'alice-gemini-serper',
      message: 'Use POST /api for Alice.'
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');

    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  const start = Date.now();

  const remaining = () =>
    Math.max(
      0,
      TOTAL_BUDGET_MS - (Date.now() - start)
    );

  const body =
    req.body && typeof req.body === 'object'
      ? req.body
      : {};

  const question = cleanText(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ''
  ).slice(0, 600);

  const history = safeHistory(
    body?.state?.session?.history
  );

  if (!question) {
    return res.status(200).json(
      aliceResponse(
        'Привет! Задай вопрос, и я постараюсь помочь.',
        false,
        history
      )
    );
  }

  let answer;

  // Для свежей информации используем Serper
  if (isSearchIntent(question)) {
    const result = await searchWeb(
      question,
      Math.min(
        SEARCH_TIMEOUT_MS,
        Math.max(300, remaining() - 400)
      )
    );

    answer = result.text ||
      'Сейчас не удалось получить актуальные данные из интернета. Попробуй немного позже.';

    console.info(
      'Alice search status',
      result.reason,
      'total_ms',
      Date.now() - start
    );
  } else {
    // Для обычного разговора используем Gemini
    try {
      answer = await askGemini(
        question,
        history,
        Math.min(
          GEMINI_TIMEOUT_MS,
          Math.max(300, remaining() - 450)
        )
      );
    } catch (error) {
      console.warn(
        'Gemini error',
        error?.name || 'Error',
        cleanText(error?.message).slice(0, 120)
      );

      answer = fallback(error);
    }
  }

  const nextHistory = [
    ...history,
    { role: 'user', text: question },
    { role: 'model', text: answer }
  ].slice(-HISTORY_LIMIT);

  return res.status(200).json(
    aliceResponse(answer, false, nextHistory)
  );
}

export {
  aliceResponse,
  fitAliceText,
  isSearchIntent,
  safeHistory,
  formatWebResult
};
