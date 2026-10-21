# Analytic Topic Service

Сервис для поиска и валидации тематических ниш на основе динамики каналов видеоплатформ. Апробация на открытых данных YouTube (YouTube Data API v3).

Анализирует каналы по запросу, считает метрики стабильности (`medianViews`, `spikeRatio`, `cv`, `consistency`) и отделяет стабильный рост от разового всплеска одного видео.

## Стек

`FastAPI + SQLAlchemy + SQLite / PostgreSQL + Vue 3 (Vite + TypeScript + Tailwind + ECharts)` · `YouTube Data API v3` · `GA4 / Plausible`

## Архитектура

```
frontend (Vue 3) --REST--> backend (FastAPI) -- DataSourceAdapter -> YouTubeAdapter
                                              --> DB: channels / videos / snapshots
```

`DataSourceAdapter` — точка расширения на другие платформы. Первая реализация — `YouTubeAdapter`.

## Структура

```
backend/  — API, адаптеры, модели БД
frontend/ — SPA (после Этапа 3)
```

## Быстрый старт

```bash
# backend
cd backend
python -m venv .venv && source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env  # вставь YOUTUBE_API_KEY
uvicorn app.main:app --reload  # http://localhost:8000/docs
```

`.env`:

```
YOUTUBE_API_KEY=...
DATABASE_URL=sqlite:///./app.db  # для прод: postgresql://...
```

Проверка адаптера:

```python
from app.adapters.youtube import YouTubeAdapter
from app.config import settings
a = YouTubeAdapter(settings.youtube_api_key)
print(a.search_channels("faceless meditation", limit=5))
```

## Деплой

* backend → Render
* frontend → Vercel
* Аналитика — GA4 / Plausible (1 скрипт в `index.html`)
