from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .database import engine, Base

import app.models.channel  # ensure models imported
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Analytic Topic Service",
    description="Поиск видео + карточка видео/канала + фильтры (YouTube Data API v3, public data).",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from .routers.search import router as search_router
from .routers.videos import router as videos_router
from .routers.channels import router as channels_router
app.include_router(search_router)
app.include_router(videos_router)
app.include_router(channels_router)

@app.get("/")
def root():
    return {"service": "analytic-topic-service", "docs": "/docs", "health": "/api/health"}

@app.get("/api/health")
def health():
    return {"status": "ok"}
