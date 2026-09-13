FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /uvx /bin/

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# These are bounded local runtime tools, not heavyweight VLM/provider models.
# They make the default container capable of real OCR, scanned-PDF
# rasterization and video audio demux while Docling/Marker remain opt-in extras.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       poppler-utils \
       tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock ./
COPY app ./app

RUN uv sync --locked --no-dev

ENV PATH="/app/.venv/bin:$PATH"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
