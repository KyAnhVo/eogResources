# The console built into the FastAPI backend, served from one origin (Render; locally:
# docker build -t beat-the-shutdown . && docker run -p 8000:8000 beat-the-shutdown).

FROM node:24-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# tsc --noEmit && vite build: a type error fails the build, so the deploy never goes live.
RUN npm run build

FROM python:3.14-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /uvx /usr/local/bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_CACHE=1
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/app ./app
# Python type errors fail the build too (research/ is not shipped or checked).
RUN uvx --from 'pyright[nodejs]' pyright app --pythonpath .venv/bin/python
COPY --from=frontend /src/frontend/dist /app/frontend/dist

ENV STATIC_DIR=/app/frontend/dist PATH="/app/backend/.venv/bin:$PATH" PORT=8000
EXPOSE 8000
# One process, no --reload/--workers: datasets and live state live in this process's memory.
# Shell form so Render's $PORT is expanded; exec so uvicorn receives SIGTERM.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"$PORT\""]
