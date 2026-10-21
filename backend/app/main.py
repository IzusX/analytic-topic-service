from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .database import engine, Base

import app.models.channel  # ensure models imported
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Аналитический сервис подбора тем для видеоконтента",
    description="Этап 0 — фундамент: адаптер + БД. Реализация метрик и API — Этапы 1-2.",
    version="0.0.1",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"service": "analytic-topic-service", "stage": 0, "docs": "/docs", "health": "/api/health"}

@app.get("/api/health")
def health():
    return {"status": "ok", "stage": 0}
