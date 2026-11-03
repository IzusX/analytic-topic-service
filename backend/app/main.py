from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from .database import engine
from .migrate import assert_schema_current
from .schemas.error import ERROR_RESPONSES
from .routers.search import router as search_router
from .routers.videos import router as videos_router
from .routers.channels import router as channels_router


@asynccontextmanager
async def lifespan(_app):
    # Startup checks a schema; it never modifies or recreates an existing database.
    assert_schema_current(engine)
    yield


app = FastAPI(
    title="Analytic Topic Service",
    description="Поиск публичных видео YouTube и описательная аналитика явно ограниченной выборки канала.",
    version="0.2.0",
    lifespan=lifespan,
    responses=ERROR_RESPONSES,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(search_router)
app.include_router(videos_router)
app.include_router(channels_router)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError):
    # Do not echo arbitrary input: request bodies can contain credentials in unknown fields.
    errors = [{"loc": list(error["loc"]), "type": error["type"], "message": "Некорректное значение поля."} for error in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": {
        "code": "invalid_request", "message": "Проверьте параметры запроса.", "retryable": False, "fields": errors,
    }})


@app.exception_handler(SQLAlchemyError)
async def database_error(_request: Request, _exc: SQLAlchemyError):
    return JSONResponse(status_code=500, content={"detail": {
        "code": "database_error", "message": "Не удалось сохранить данные. Повторите позже.", "retryable": True,
    }})


@app.get("/")
def root():
    return {"service": "analytic-topic-service", "docs": "/docs", "health": "/api/health"}


@app.get("/api/health")
def health():
    return {"status": "ok", "schema_version": 2}
