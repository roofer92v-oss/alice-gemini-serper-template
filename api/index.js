
const MODEL = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();

const TOTAL_MS = 3900;
const SEARCH_MS = 1100;
const GEMINI_MS = 2500;
const DIRECT_MS = 1500;

const SYSTEM = `Ты умный голосовой ИИ-помощник в Яндекс Алисе.
Говори по-русски, естественно и понятно.
Обычно отвечай в 1-3 предложениях.
Если просят подробности, объясняй подробнее.
Учитывай предыдущие реплики.
Если предоставлены сведения из интернета, анализируй их,
а не просто зачитывай заголовки.
Не придумывай факты, цены, курсы, даты и новости.
Не используй Markdown.
Если данных недостаточно, честно сообщи об этом.`;

const clean = x => String(x ?? '')
  .replace(/\s+/g, ' ')
  .trim();

function short(x, n = 900) {
  const s = clean(x);
  if (s.length <= n) return s;
  return s.slice(0, n - 1)
    .replace(/\s+\S*$/, '') + '…';
}

function historyOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(x =>
    x &&
    ['user', 'model'].includes(x.role) &&
    typeof x.text === 'string'
  ).slice(-4).map(x => ({
    role: x.role,
    text: short(x.text, 110)
  }));
}

function alice(text, history = []) {
  const h = historyOf(history);

  while (
    h.length &&
    Buffer.byteLength(JSON.stringify({ history: h }), 'utf8') > 850
  ) h.shift();

  return {
    version: '1.0',
    response: {
      text: short(text),
      end_session: false
    },
    session_state: { history: h }
  };
}

async function timedFetch(url, options = {}, ms = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    const r = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!r.ok) {
      throw new Error('HTTP_' + r.status);
    }

    return r;
  } finally {
    clearTimeout(timer);
  }
}

function needsSearch(q, history) {
  if (
    /сегодня|сейчас|вчера|завтра|последн|новост|свеж|актуальн|найди|поищи|интернет|погод|температур|сколько стоит|цен[аыуе]|курс|доллар|евро|расписани|котиров|бирж|результат матча/i.test(q)
  ) return true;

  const last = [...history].reverse()
    .find(x => x.role === 'user');

  return !!last &&
    /^(а |и |сколько |какой |что насчёт)/i.test(q) &&
    /новост|погод|курс|доллар|евро|цен/i.test(last.text);
}

function isCurrency(q) {
  return /доллар|usd|евро|eur/i.test(q) &&
    /курс|рубл|сколько стоит|центробанк|цб/i.test(q);
}

async function currency(q) {
  const code = /евро|eur/i.test(q) ? 'EUR' : 'USD';
  const name = code === 'USD' ? 'доллар' : 'евро';

  const r = await timedFetch(
    'https://www.cbr.ru/scripts/XML_daily.asp',
    {},
    DIRECT_MS
  );

  const bytes = await r.arrayBuffer();
  const xml = new TextDecoder('windows-1251').decode(bytes);

  const blocks = [...xml.matchAll(
    /<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g
  )];

  const block = blocks.map(x => x[1]).find(x =>
    x.includes(`<CharCode>${code}</CharCode>`)
  );

  if (!block) throw new Error('CBR_CURRENCY_NOT_FOUND');

  const value = block.match(
    /<Value>([\d,]+)<\/Value>/
  )?.[1];

  const nominal = block.match(
    /<Nominal>(\d+)<\/Nominal>/
  )?.[1];

  const date = xml.match(
    /<ValCurs[^>]*Date="([^"]+)"/
  )?.[1];

  const rate = Number(value?.replace(',', '.')) /
    Number(nominal);

  if (!Number.isFinite(rate) || !date) {
    throw new Error('CBR_INVALID_DATA');
  }

  const formatted = rate.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  return `По официальному курсу Банка России на ${date}, один ${name} стоит ${formatted} рубля. Это курс ЦБ, а не курс покупки или продажи в банке.`;
}

function weatherCode(code) {
  if (code === 0) return 'ясно';
  if ([1, 2].includes(code)) return 'переменная облачность';
  if (code === 3) return 'пасмурно';
  if ([45, 48].includes(code)) return 'туман';
  if ([51, 53, 55, 56, 57].includes(code)) return 'морось';
  if ([61, 63, 65, 66, 67].includes(code)) return 'дождь';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'снег';
  if ([80, 81, 82].includes(code)) return 'ливень';
  if ([95, 96, 99].includes(code)) return 'гроза';
  return 'погодные условия уточняются';
}

function isLocalWeather(q) {
  return /погод|температур|сколько градус|снег|дожд/i.test(q)
    && /мончегорск/i.test(q);
}

async function localWeather() {
  const url = 'https://api.open-meteo.com/v1/forecast?' +
    new URLSearchParams({
      latitude: '67.94',
      longitude: '32.87',
      current: 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
      timezone: 'Europe/Moscow'
    });

  const r = await timedFetch(url, {}, DIRECT_MS);
  const data = await r.json();
  const c = data.current;

  if (!c || !Number.isFinite(c.temperature_2m)) {
    throw new Error('WEATHER_INVALID_DATA');
  }

  const t = Math.round(c.temperature_2m);
  const felt = Math.round(c.apparent_temperature);
  const wind = Math.round(c.wind_speed_10m);

  return `В Мончегорске сейчас ${t} градусов, ${weatherCode(c.weather_code)}. По ощущениям ${felt}. Ветер около ${wind} километров в час. Данные погодной модели Open-Meteo.`;
}

function extractSearch(data) {
  const lines = [];

  if (data.answerBox) {
    const a = data.answerBox;
    const value = clean(
      a.answer || a.snippet || a.title
    );
    if (value) lines.push('Быстрый ответ: ' + short(value, 300));
  }

  if (data.knowledgeGraph?.description) {
    lines.push(
      'Справка: ' +
      short(data.knowledgeGraph.description, 250)
    );
  }

  for (const item of (data.organic || []).slice(0, 4)) {
    lines.push(
      'Источник: ' + short(item.title, 90) +
      '. Фрагмент: ' + short(item.snippet, 300) +
      '. Ссылка: ' + clean(item.link)
    );
  }

  return lines.join('\n').slice(0, 1800);
}

function usefulFallback(data) {
  const box = clean(
    data.answerBox?.answer ||
    data.answerBox?.snippet ||
    data.knowledgeGraph?.description
  );

  if (box) {
    return 'По найденным данным: ' + short(box, 400);
  }

  const snippets = (data.organic || [])
    .map(x => clean(x.snippet))
    .filter(x => x.length > 50)
    .slice(0, 2);

  if (!snippets.length) {
    return 'Поиск завершился, но достоверного ответа получить не удалось.';
  }

  return 'Нашла следующие сведения, но не успела их полностью проверить: ' +
    snippets.map(x => short(x, 190)).join(' ');
}

async function serper(q, ms) {
  if (!process.env.SERPER_API_KEY) {
    throw new Error('SERPER_KEY_MISSING');
  }

  const r = await timedFetch(
    'https://google.serper.dev/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': process.env.SERPER_API_KEY
      },
      body: JSON.stringify({
        q,
        gl: 'ru',
        hl: 'ru',
        num: 4
      })
    },
    ms
  );

  return r.json();
}

async function gemini(q, history, context, ms) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_KEY_MISSING');
  }

  if (!/^[A-Za-z0-9._-]+$/.test(MODEL)) {
    throw new Error('INVALID_GEMINI_MODEL');
  }

  const contents = historyOf(history).map(x => ({
    role: x.role,
    parts: [{ text: x.text }]
  }));

  const prompt = context
    ? `Вопрос пользователя: ${q}

Данные интернет-поиска:
${context}

Ответь непосредственно на вопрос.
Проанализируй фрагменты, не перечисляй сайты.
Не выдумывай отсутствующие факты.
Отличай дату статьи от даты события.
Если найденные фрагменты не подтверждают точное значение,
скажи об ограничении информации.`
    : q;

  contents.push({
    role: 'user',
    parts: [{ text: prompt }]
  });

  const generationConfig = {
    temperature: 0.3,
    maxOutputTokens: 210
  };

  // Отключаем лишнее размышление для моделей 2.5
  if (/^gemini-2\.5-(flash|flash-lite)/.test(MODEL)) {
    generationConfig.thinkingConfig = {
      thinkingBudget: 0
    };
  }

  const r = await timedFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM }]
        },
        contents,
        generationConfig
      })
    },
    ms
  );

  const data = await r.json();

  const answer = (
    data.candidates?.[0]?.content?.parts || []
  ).map(x => x.text || '').join('').trim();

  if (!answer) throw new Error('GEMINI_EMPTY');

  return answer;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'alice-gemini-serper',
      model: MODEL,
      message: 'Webhook ready'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  const started = Date.now();
  const remaining = () =>
    Math.max(0, TOTAL_MS - (Date.now() - started));

  const body = req.body && typeof req.body === 'object'
    ? req.body : {};

  const q = clean(
    body.request?.command ||
    body.request?.original_utterance ||
    ''
  ).slice(0, 500);

  const history = historyOf(body.state?.session?.history);

  if (!q) {
    return res.status(200).json(
      alice('Привет! Слушаю тебя.', history)
    );
  }

  let answer = '';
  let searchData = null;
  let searchUsed = false;

  // Точные данные: прямые источники
  if (isCurrency(q) || isLocalWeather(q)) {
    try {
      answer = isCurrency(q)
        ? await currency(q)
        : await localWeather();

      console.info('Direct data OK', Date.now() - started);
    } catch (e) {
      console.warn('Direct data error', e.name, e.message);

      // Если прямой источник недоступен, продолжим поиск
      answer = '';
    }
  }

  // Свежие данные: Serper + Gemini
  if (!answer && needsSearch(q, history)) {
    searchUsed = true;

    try {
      searchData = await serper(
        q,
        Math.min(SEARCH_MS, Math.max(200, remaining() - 2600))
      );

      console.info('Serper OK', Date.now() - started);
    } catch (e) {
      console.warn(
        'Serper failure',
        e.name,
        e.message,
        Date.now() - started
      );
    }

    if (searchData) {
      try {
        answer = await gemini(
          q,
          history,
          extractSearch(searchData),
          Math.min(GEMINI_MS, Math.max(200, remaining() - 350))
        );
      } catch (e) {
        console.warn(
          'Gemini search failure',
          e.name,
          e.message
        );

        answer = usefulFallback(searchData);
      }
    } else {
      answer = 'Сейчас не удалось получить свежие данные из интернета. Попробуй повторить запрос.';
    }
  }

  // Обычные вопросы: Gemini
  if (!answer && !searchUsed) {
    try {
      answer = await gemini(
        q,
        history,
        '',
        Math.min(GEMINI_MS, Math.max(200, remaining() - 350))
      );
    } catch (e) {
      console.warn(
        'Gemini chat failure',
        e.name,
        e.message
      );

      answer = e.message === 'GEMINI_KEY_MISSING'
        ? 'Не настроен ключ Gemini в Vercel.'
        : 'Сейчас не получилось ответить. Повтори вопрос, пожалуйста.';
    }
  }

  console.info('Alice completed', Date.now() - started, {
    searchUsed,
    hasSearchData: !!searchData,
    model: MODEL
  });

  return res.status(200).json(
    alice(answer, [
      ...history,
      { role: 'user', text: q },
      { role: 'model', text: answer }
    ])
  );
}
