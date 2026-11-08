.PHONY: install backend frontend demo score typecheck

install:
	cd backend && uv sync
	cd frontend && npm install

backend:
	cd backend && uv run uvicorn app.main:app --port 8000 --reload

frontend:
	cd frontend && npm run dev

# Backend on :8000, frontend on http://localhost:5173 (proxies /api). Ctrl-C stops both.
demo: install
	$(MAKE) -j2 backend frontend

# Detection vs every answer_key.json under data/.
score:
	cd backend && uv run python -m app.score

typecheck:
	cd frontend && npx tsc --noEmit
