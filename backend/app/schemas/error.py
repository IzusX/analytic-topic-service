from pydantic import BaseModel, Field


class ValidationFieldError(BaseModel):
    loc: list[str | int]
    type: str
    message: str


class ApiErrorDetail(BaseModel):
    code: str
    message: str
    retryable: bool = False
    fields: list[ValidationFieldError] | None = None


class ApiErrorResponse(BaseModel):
    detail: ApiErrorDetail


ERROR_RESPONSES = {
    status: {"model": ApiErrorResponse}
    for status in (400, 404, 422, 429, 500, 502, 503)
}
