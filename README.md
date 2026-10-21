# Аналитический сервис подбора тем для видеоконтента

ВКР 09.03.03 ПИКД — «Разработка аналитического сервиса подбора тем для видеоконтента».
Трактовка: под «подбором тем» понимается поиск и валидация перспективных тематических ниш по динамике каналов-авторов на основе открытых данных (апробация на YouTube).

## Стек (зафиксирован)

`FastAPI + Vue 3 (Vite+TS+Tailwind+Naive UI+ECharts) + SQLite -> PostgreSQL + YouTube Data API v3 + GA4/Plausible`
Деплой: `Render (api) + Vercel (web)`. ИИ: код без ограничений (30% в форме по самоотчету), текст — рерайт до 20%.

## Архитектура (адаптер)

```
frontend --REST--> backend -- DataSourceAdapter -> YouTubeAdapter (google-api-python-client)
                         --> DB: channels / videos / snapshots
```

## Этап 0 — фундамент (текущий)

* `backend/app/adapters/base.py` — интерфейс `DataSourceAdapter`
* `backend/app/adapters/youtube.py` — `YouTubeAdapter` (public data, по API-ключу)
* `backend/app/models/channel.py` — таблицы `channels / videos / snapshots`
* `backend/app/config.py` + `database.py` + `main.py` — заглушка `/api/health`

Далее: Этап 1 — метрики `median/spikeRatio/cv/consistency` и проверка гипотезы на 2 нишах.

## Быстрый старт (Этап 0)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # вставь YOUTUBE_API_KEY
cp ../.env.example .env  # альтернатива
uvicorn app.main:app --reload  # http://localhost:8000/docs
```

Проверка адаптера (после вставки ключа):
```python
from app.adapters.youtube import YouTubeAdapter
from app.config import settings
a = YouTubeAdapter(settings.youtube_api_key)
print(a.search_channels("faceless meditation", limit=5))
```

## Коммиты

История по ходу — каждый этап отдельным коммитом.
