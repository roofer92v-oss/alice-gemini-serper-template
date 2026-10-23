
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const BUDGET_MS = 3800;
const SEARCH_MS = 1350;
const GEMINI_MS = 2250;
const MAX_TEXT = 900;

const SYSTEM = `Ты умный голосовой помощник в навыке Яндекс Алисы.
Отвечай по-русски, естественно и по существу, обычно в 1–3 предложениях.
Если пользователь просит подробности, объясняй подробнее, но не длиннее 900 символов.
Учитывай контекст разговора. Не используй Markdown и списки.
При наличии данных поиска анализируй их, отвечай именно на вопрос,
а не пересказывай названия сайтов.
Не выдумывай цифры, даты, прогнозы или события, которых нет в источниках.
Для курса валют различай официальный и рыночный курсы.
Если источники недостаточны, скажи об этом.`;

const clean = x => String(x ?? '').replace(/\s+/g, ' ').trim();

const trimText = (x, max = MAX_TEXT) => {
  const s = clean(x);
  if (s.length <= max) return s || 'Не удалось подготовить ответ.';
  return s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
};

const timeLeft = started =>
  Math.max(0, BUDGET_MS - (Date.now() - started));

function compactHistory(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(x =>
      x &&
      ['user', 'model'].includes(x.role) &&
      typeof x.text === 'string'
    )
    .slice(-4)
    .map(x => ({
      role: x.role,
      text: trimText(x.text, 110)
    }));
}

function response(text, history = []) {
  let stateHistory = compactHistory(history);

  while (
    Buffer.byteLength(
      JSON.stringify({ history: stateHistory }),
      'utf8'
    ) > 850
  ) {
    stateHistory.shift();
  }

  return {
    version: '1.0',
    response: {
      text: trimText(text),
      end_session: false
    },
    session_state: {
      history: stateHistory
    }
  };
}

function searchNeeded(question, history) {
  if (
    /сегодня|сейчас|вчера|завтра|на этой неделе|последн|свеж|новост|погод|температур|курс|доллар|евро|валют|цен[аыуе]|сколько стоит|бирж|акци|котиров|расписан|результат матч|найди|поищи|поиск|интернет|актуальн|2026|today|latest|current|weather|news/i.test(question)
  ) {
    return true;
  }

  const lastUser = [...history]
    .reverse()
    .find(x => x.role === 'user');

  return !!lastUser &&
    /^(а |и |ну |сколько |какой |что насчёт|а теперь)/i.test(question) &&
    /погод|курс|новост|цен|котиров|бирж/i.test(lastUser.text);
}

async function requestJson(url, init, ms) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    Math.max(150, ms)
  );

  try {
    const r = await fetch(url, {
      ...init,
      signal: controller.signal
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      throw new Error(`HTTP_${r.status}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function getSearch(question, ms) {
  if (!process.env.SERPER_API_KEY) {
    throw new Error('SERPER_KEY_MISSING');
  }

  const start = Date.now();

  try {
    const data = await requestJson(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          q: question,
          gl: 'ru',
          hl: 'ru',
          num: 5
        })
      },
      ms
    );

    const entries = [];
    const answer = data.answerBox;

    if (answer) {
      entries.push(
        'Быстрый ответ: ' +
        clean(
          answer.answer ||
          answer.snippet ||
          answer.title
        ).slice(0, 350)
      );
    }

    if (data.knowledgeGraph?.description) {
      entries.push(
        'Справка: ' +
        clean(data.knowledgeGraph.description).slice(0, 300)
      );
    }

    for (const item of (data.organic || []).slice(0, 4)) {
      if (item?.title || item?.snippet) {
        entries.push(
          `Источник: ${clean(item.title).slice(0, 100)}. ` +
          `Содержание: ${clean(item.snippet).slice(0, 240)}. ` +
          `URL: ${clean(item.link).slice(0, 160)}`
        );
      }
    }

    console.info(
      'Serper OK',
      Date.now() - start,
      'ms',
      entries.length,
      'items'
    );

    return entries.join('\n').slice(0, 1900);
  } catch (e) {
    console.warn(
      'Serper failure:',
      e.name,
      e.message,
      'after',
      Date.now() - start,
      'ms'
    );

    throw e;
  }
}

async function getGemini(question, history, searchText, ms) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_KEY_MISSING');
  }

  if (!/^[\w.-]+$/.test(MODEL)) {
    throw new Error('INVALID_MODEL');
  }

  const userPrompt = searchText
    ? `${question}

Ниже сведения из интернета. Сопоставь их и сформулируй
содержательный ответ, а не список заголовков.
Не утверждай, что данные проверены на момент запроса,
если из источника этого не следует.

${searchText}`
    : question;

  const contents = compactHistory(history).map(x => ({
    role: x.role,
    parts: [{ text: x.text }]
  }));

  contents.push({
    role: 'user',
    parts: [{ text: userPrompt }]
  });

  const start = Date.now();

  try {
    const data = await requestJson(
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
          generationConfig: {
            temperature: 0.35,
            maxOutputTokens: 230
          }
        })
      },
      ms
    );

    const text = (
      data.candidates?.[0]?.content?.parts || []
    )
      .map(p => p.text || '')
      .join('')
      .trim();

    if (!text) {
      throw new Error('EMPTY_GEMINI_RESPONSE');
    }

    console.info(
      'Gemini OK',
      Date.now() - start,
      'ms'
    );

    return text;
  } catch (e) {
    console.warn(
      'Gemini failure:',
      e.name,
      e.message,
      'after',
      Date.now() - start,
      'ms'
    );

    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'alice-gemini-serper',
      message: 'POST /api'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  const started = Date.now();

  const body =
    req.body && typeof req.body === 'object'
      ? req.body
      : {};

  const q = clean(
    body.request?.command ||
    body.request?.original_utterance
  ).slice(0, 500);

  const history = compactHistory(
    body.state?.session?.history
  );

  if (!q) {
    return res.status(200).json(
      response('Привет! О чём поговорим?', history)
    );
  }

  const needsSearch = searchNeeded(q, history);

  let result;
  let searchContext = '';
  let searchError = false;

  if (needsSearch) {
    try {
      searchContext = await getSearch(
        q,
        Math.min(
          SEARCH_MS,
          Math.max(200, timeLeft(started) - 2350)
        )
      );
    } catch (e) {
      searchError = true;
    }
  }

  if (needsSearch && !searchContext) {
    result =
      'Сейчас не удалось получить свежие данные из интернета. ' +
      'Могу ответить на общий вопрос или попробуй повторить запрос.';
  } else {
    try {
      result = await getGemini(
        q,
        history,
        searchContext,
        Math.min(
          GEMINI_MS,
          Math.max(200, timeLeft(started) - 330)
        )
      );
    } catch (e) {
      if (needsSearch) {
        result =
          'Я нашла сведения в интернете, но не успела ' +
          'их надёжно обработать. Попробуй уточнить вопрос.';
      } else if (e.message === 'GEMINI_KEY_MISSING') {
        result = 'В Vercel не настроен ключ Gemini.';
      } else {
        result =
          'Нейросеть не успела ответить. ' +
          'Повтори вопрос, пожалуйста.';
      }
    }
  }

  console.info(
    'Alice completed',
    Date.now() - started,
    'ms',
    { needsSearch, searchError }
  );

  return res.status(200).json(
    response(result, [
      ...history,
      { role: 'user', text: q },
      { role: 'model', text: result }
    ])
  );
}
