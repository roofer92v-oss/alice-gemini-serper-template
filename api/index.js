
/*
 * Яндекс Алиса + Gemini + Serper
 * Погода: Open-Meteo
 * Валюты: Банк России
 * Для Vercel, Node.js 20+
 * Без дополнительных npm-пакетов
 */

const MODEL = (process.env.GEMINI_MODEL || "gemini-2.5-flash-lite").trim();

const TOTAL_MS = 3850;
const SEARCH_MS = 1300;
const GEMINI_MS = 2550;
const DIRECT_MS = 1900;

const SYSTEM = [
  "Ты умный голосовой помощник Яндекс Алисы.",
  "Говори по-русски, естественно, понятно, дружелюбно.",
  "Отвечай по существу, обычно в 1-3 предложениях.",
  "Учитывай предыдущие реплики разговора.",
  "Если есть результаты поиска, анализируй содержание,",
  "не зачитывай названия сайтов и не придумывай факты.",
  "Если информации недостаточно, честно сообщи об этом.",
  "Не используй Markdown. Ответ должен звучать хорошо голосом."
].join(" ");

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function short(value, max = 850) {
  const text = clean(value);
  if (text.length <= max) return text;
  return text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

function contextFromState(state) {
  const obj = state && typeof state === "object" ? state : {};
  const history = Array.isArray(obj.history)
    ? obj.history.filter(x =>
        x && ["user", "model"].includes(x.role) &&
        typeof x.text === "string"
      ).slice(-4).map(x => ({
        role: x.role,
        text: short(x.text, 105)
      }))
    : [];

  return {
    history,
    topic: typeof obj.topic === "string" ? obj.topic.slice(0, 20) : "",
    city: typeof obj.city === "string" ? obj.city.slice(0, 80) : ""
  };
}

function aliceReply(text, state) {
  const next = {
    topic: state.topic || "",
    city: state.city || "",
    history: state.history || []
  };

  while (
    next.history.length &&
    Buffer.byteLength(JSON.stringify(next), "utf8") > 850
  ) {
    next.history.shift();
  }

  return {
    version: "1.0",
    response: {
      text: short(text || "Не удалось получить ответ."),
      end_session: false
    },
    session_state: next
  };
}

function addHistory(state, question, answer) {
  return {
    ...state,
    history: [
      ...state.history,
      { role: "user", text: short(question, 105) },
      { role: "model", text: short(answer, 105) }
    ].slice(-4)
  };
}

// Важно: таймер работает и во время чтения ответа.
async function request(url, options = {}, timeout = 1500, type = "json") {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(100, timeout)
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error("HTTP_" + response.status);
    }

    if (type === "text") return await response.text();
    if (type === "buffer") return await response.arrayBuffer();
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function weatherWords(q) {
  return /погод|температур|градус|снег|снегопад|осадк|дожд|ветер|мороз|потеплен|прогноз/i.test(q);
}

function timeWords(q) {
  return /завтра|послезавтра|недел|выходн|суббот|воскресен|когда|будет|ожида|ближайш/i.test(q);
}

function looksLikeFollowup(q) {
  return /^(а |и |ну |что |как |когда |сколько |будет ли |на |завтра|послезавтра)/i.test(q)
    && q.length < 85;
}

function isCurrency(q, state) {
  if (/доллар|usd|евро|eur/i.test(q) &&
      /курс|рубл|сто(и|я)т|сколько|центробанк|цб/i.test(q)) {
    return true;
  }
  return state.topic === "currency" &&
    looksLikeFollowup(q) &&
    /курс|доллар|евро|рубл|сегодня|завтра/i.test(q);
}

function isMonchegorskWeather(q, state) {
  const city = /мончегорск/i.test(q);
  const otherCity = /(?:в|для)\s+(?!мончегорск)[а-яё-]+\s/i.test(q)
    && !city;

  if (city && weatherWords(q)) return true;

  if (state.topic === "weather" && state.city === "Мончегорск" &&
      !otherCity && (
        weatherWords(q) ||
        (timeWords(q) && looksLikeFollowup(q))
      )) {
    return true;
  }

  return false;
}

function needsSearch(q, state) {
  if (/сегодня|сейчас|последн|новост|свеж|актуальн|найди|поищи|интернет|цена|цены|сколько стоит|котиров|бирж|расписан|результат матча|погод|прогноз|курс|доллар|евро/i.test(q)) {
    return true;
  }

  return state.topic === "search" && looksLikeFollowup(q);
}

// Текущее местное время и дата для Мончегорска
function localDate() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type => parts.find(x => x.type === type)?.value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayIndex(dateString) {
  const [y, m, d] = dateString.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function dayLabel(dateString) {
  const [y, m, d] = dateString.split("-").map(Number);
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function weatherDescription(code) {
  if (code === 0) return "ясно";
  if ([1, 2].includes(code)) return "переменная облачность";
  if (code === 3) return "пасмурно";
  if ([45, 48].includes(code)) return "туман";
  if ([51, 53, 55, 56, 57].includes(code)) return "морось";
  if ([61, 63, 65, 66, 67].includes(code)) return "дождь";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "снег";
  if ([80, 81, 82].includes(code)) return "ливень";
  if ([95, 96, 99].includes(code)) return "гроза";
  return "погодные условия уточняются";
}

async function weather(q) {
  const params = new URLSearchParams({
    latitude: "67.94",
    longitude: "32.87",
    timezone: "Europe/Moscow",
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
    daily: "snowfall_sum,temperature_2m_min,temperature_2m_max,weather_code",
    forecast_days: "7"
  });

  const data = await request(
    "https://api.open-meteo.com/v1/forecast?" + params.toString(),
    {},
    DIRECT_MS
  );

  const now = data.current;
  const daily = data.daily;

  const forecastQuestion = timeWords(q) ||
    /снег|снегопад|прогноз/i.test(q);

  if (!forecastQuestion) {
    if (!Number.isFinite(now?.temperature_2m)) {
      throw new Error("WEATHER_DATA_MISSING");
    }

    return `В Мончегорске сейчас ${Math.round(now.temperature_2m)} градусов, ${weatherDescription(now.weather_code)}. По ощущениям ${Math.round(now.apparent_temperature)}. Ветер около ${Math.round(now.wind_speed_10m)} километров в час.`;
  }

  if (!Array.isArray(daily?.time)) {
    throw new Error("FORECAST_DATA_MISSING");
  }

  const today = localDate();
  const weekDay = dayIndex(today);
  const daysUntilSunday = (7 - weekDay) % 7;

  const todayUTC = Date.parse(today + "T00:00:00Z");

  const rows = daily.time.map((date, i) => ({
    date,
    offset: Math.round(
      (Date.parse(date + "T00:00:00Z") - todayUTC) / 86400000
    ),
    snow: Number(daily.snowfall_sum?.[i]),
    low: Number(daily.temperature_2m_min?.[i]),
    high: Number(daily.temperature_2m_max?.[i]),
    code: daily.weather_code?.[i]
  }));

  let selected = rows;

  if (/послезавтра/i.test(q)) {
    selected = rows.filter(x => x.offset === 2);
  } else if (/завтра/i.test(q)) {
    selected = rows.filter(x => x.offset === 1);
  } else if (/выходн|суббот|воскресен/i.test(q)) {
    const saturday = (6 - weekDay + 7) % 7;
    const sunday = (7 - weekDay) % 7;

    selected = rows.filter(x =>
      x.offset === saturday || x.offset === sunday
    );
  } else if (/этой недел|на недел/i.test(q)) {
    selected = rows.filter(x =>
      x.offset >= 0 && x.offset <= daysUntilSunday
    );
  } else if (/сегодня/i.test(q)) {
    selected = rows.filter(x => x.offset === 0);
  } else {
    selected = rows.filter(x => x.offset >= 0 && x.offset < 7);
  }

  if (!selected.length) {
    return "Прогноз на указанный период пока недоступен.";
  }

  if (/температур|градус|мороз|потеплен/i.test(q) &&
      !/снег|осадк/i.test(q)) {
    const values = selected
      .filter(x => Number.isFinite(x.low) && Number.isFinite(x.high))
      .slice(0, 4)
      .map(x =>
        `${dayLabel(x.date)} от ${Math.round(x.low)} до ${Math.round(x.high)} градусов`
      );

    return values.length
      ? "Прогноз для Мончегорска: " + values.join("; ") + "."
      : "Не удалось прочитать температуру из прогноза.";
  }

  const valid = selected.filter(x => Number.isFinite(x.snow));

  if (!valid.length) {
    return "Данные о количестве снега пока недоступны.";
  }

  const snowy = valid.filter(x => x.snow > 0);

  if (/снег|снегопад|осадк|когда|будет/i.test(q)) {
    if (!snowy.length) {
      return "По текущему прогнозу, в указанный период снег в Мончегорске не ожидается. Прогноз может измениться.";
    }

    const items = snowy.slice(0, 3).map(x =>
      `${dayLabel(x.date)} около ${x.snow.toFixed(1).replace(".", ",")} сантиметра`
    );

    return "Да, по прогнозу снег в Мончегорске ожидается: " +
      items.join("; ") + ". Прогноз может измениться.";
  }

  const items = selected.slice(0, 4).map(x =>
    `${dayLabel(x.date)}: ${weatherDescription(x.code)}, от ${Math.round(x.low)} до ${Math.round(x.high)} градусов`
  );

  return "Прогноз для Мончегорска: " + items.join("; ") + ".";
}

// Официальные курсы валют ЦБ России
async function currency(q, state) {
  let code = /евро|eur/i.test(q) ? "EUR" : "USD";

  if (!/евро|eur|доллар|usd/i.test(q) &&
      /евро|eur/i.test(
        [...state.history].reverse()
          .find(x => x.role === "user")?.text || ""
      )) {
    code = "EUR";
  }

  const bytes = await request(
    "https://www.cbr.ru/scripts/XML_daily.asp",
    {},
    DIRECT_MS,
    "buffer"
  );

  const xml = new TextDecoder("windows-1251").decode(bytes);

  const blocks = [...xml.matchAll(
    /<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g
  )];

  const block = blocks
    .map(x => x[1])
    .find(x => x.includes(`<CharCode>${code}</CharCode>`));

  if (!block) throw new Error("CURRENCY_NOT_FOUND");

  const value = block.match(/<Value>([\d,]+)<\/Value>/)?.[1];
  const nominal = block.match(/<Nominal>(\d+)<\/Nominal>/)?.[1];
  const date = xml.match(/<ValCurs[^>]*Date="([^"]+)"/)?.[1];

  const rate = Number(value?.replace(",", ".")) / Number(nominal);

  if (!Number.isFinite(rate) || !date) {
    throw new Error("CURRENCY_INVALID");
  }

  const name = code === "USD" ? "доллар" : "евро";
  const formatted = rate.toFixed(2).replace(".", ",");

  return `По официальному курсу Банка России на ${date}, один ${name} стоит ${formatted} рубля. Это не курс покупки в обменнике.`;
}

// Поиск в интернете
async function searchWeb(q, timeout) {
  if (!process.env.SERPER_API_KEY) {
    throw new Error("SERPER_KEY_MISSING");
  }

  return request(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.SERPER_API_KEY
      },
      body: JSON.stringify({
        q,
        gl: "ru",
        hl: "ru",
        num: 4
      })
    },
    timeout
  );
}

function searchContext(data) {
  const parts = [];

  const box = data.answerBox;
  if (box) {
    parts.push(
      "Ответ поисковика: " +
      short(box.answer || box.snippet || "", 300)
    );
  }

  if (data.knowledgeGraph?.description) {
    parts.push(
      "Справка: " +
      short(data.knowledgeGraph.description, 250)
    );
  }

  for (const item of (data.organic || []).slice(0, 4)) {
    if (!item.title && !item.snippet) continue;
    parts.push(
      "Заголовок: " + short(item.title, 110) +
      ". Фрагмент: " + short(item.snippet, 260)
    );
  }

  return parts.join("\n").slice(0, 1700);
}

function searchFallback(data) {
  const direct = clean(
    data.answerBox?.answer ||
    data.answerBox?.snippet ||
    data.knowledgeGraph?.description
  );

  if (direct) return "По найденным данным: " + short(direct, 450);

  const snippets = (data.organic || [])
    .map(x => clean(x.snippet))
    .filter(x => x.length > 40)
    .slice(0, 2);

  if (!snippets.length) {
    return "Поиск прошёл, но достоверного ответа я не нашла.";
  }

  return "Вот что удалось найти, но я не успела проверить подробности: " +
    snippets.map(x => short(x, 170)).join(" ");
}

// Генерация ответа Gemini
async function askGemini(q, state, webContext, timeout) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) throw new Error("GEMINI_KEY_MISSING");

  if (!/^[A-Za-z0-9._-]+$/.test(MODEL)) {
    throw new Error("INVALID_MODEL");
  }

  const contents = state.history.map(x => ({
    role: x.role,
    parts: [{ text: x.text }]
  }));

  const question = webContext
    ? `Вопрос: ${q}

Информация из интернета:
${webContext}

Проанализируй данные и дай осмысленный краткий ответ.
Не ограничивайся заголовками.
Не называй точные цифры или события, если они не подтверждены.`
    : q;

  contents.push({
    role: "user",
    parts: [{ text: question }]
  });

  const generationConfig = {
    temperature: 0.35,
    maxOutputTokens: 230
  };

  // Для Gemini 2.5 Flash / Flash-Lite ускоряем ответы.
  if (/^gemini-2\.5-(flash|flash-lite)$/.test(MODEL)) {
    generationConfig.thinkingConfig = {
      thinkingBudget: 0
    };
  }

  const result = await request(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM }]
        },
        contents,
        generationConfig
      })
    },
    timeout
  );

  const answer = (
    result.candidates?.[0]?.content?.parts || []
  ).map(x => x.text || "").join("").trim();

  if (!answer) throw new Error("GEMINI_EMPTY");

  return answer;
}

// Главный вебхук Яндекс Алисы
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook ready",
      model: MODEL
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const started = Date.now();

  const remaining = () =>
    Math.max(0, TOTAL_MS - (Date.now() - started));

  const body = req.body &&
    typeof req.body === "object" ? req.body : {};

  const state = contextFromState(body.state?.session);

  const question = clean(
    body.request?.command ||
    body.request?.original_utterance ||
    ""
  ).slice(0, 500);

  if (!question) {
    return res.status(200).json(
      aliceReply("Привет! Задавай вопрос.", state)
    );
  }

  let answer = "";
  let topic = "chat";

  if (isCurrency(question, state)) {
    topic = "currency";
    try {
      answer = await currency(question, state);
    } catch (e) {
      console.warn("Currency failure:", e.name, e.message);
      answer = "Не удалось получить официальный курс валют. Попробуй чуть позже.";
    }
  } else if (isMonchegorskWeather(question, state)) {
    topic = "weather";
    state.city = "Мончегорск";

    try {
      answer = await weather(question);
    } catch (e) {
      console.warn("Weather failure:", e.name, e.message);
      answer = "Не удалось получить прогноз погоды для Мончегорска. Попробуй чуть позже.";
    }
  } else if (needsSearch(question, state)) {
    topic = "search";
    let results = null;

    try {
      const startSearch = Date.now();

      results = await searchWeb(
        question,
        Math.min(
          SEARCH_MS,
          Math.max(200, remaining() - 2450)
        )
      );

      console.info("Serper OK", Date.now() - startSearch, "ms");
    } catch (e) {
      console.warn("Serper failure:", e.name, e.message);
    }

    if (results) {
      try {
        const startGemini = Date.now();

        answer = await askGemini(
          question,
          state,
          searchContext(results),
          Math.min(
            GEMINI_MS,
            Math.max(200, remaining() - 350)
          )
        );

        console.info("Gemini search OK",
          Date.now() - startGemini, "ms");
      } catch (e) {
        console.warn("Gemini search failure:", e.name, e.message);
        answer = searchFallback(results);
      }
    } else {
      answer = "Сейчас не удалось получить свежую информацию из интернета. Попробуй повторить запрос.";
    }
  } else {
    try {
      const startGemini = Date.now();

      answer = await askGemini(
        question,
        state,
        "",
        Math.min(
          GEMINI_MS,
          Math.max(200, remaining() - 350)
        )
      );

      console.info("Gemini chat OK",
        Date.now() - startGemini, "ms");
    } catch (e) {
      console.warn("Gemini chat failure:", e.name, e.message);

      answer = e.message === "GEMINI_KEY_MISSING"
        ? "Не настроен API-ключ Gemini в Vercel."
        : "Не успела подготовить ответ. Попробуй ещё раз.";
    }
  }

  const next = addHistory(state, question, answer);
  next.topic = topic;

  console.info("Alice completed", Date.now() - started,
    "ms", "topic:", topic);

  return res.status(200).json(aliceReply(answer, next));
}
