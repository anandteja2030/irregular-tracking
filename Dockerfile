# Production image: Python 3.12 slim + OpenCV (headless) + FastAPI
FROM python:3.12-slim

# --- System libraries required by OpenCV -------------------------------
# libglib2.0-0: runtime dependency of the opencv wheels (image I/O backends)
# libgl1:       provides libGL.so.1 referenced by some cv2 native paths
# (DL3008: pinning Debian pkg versions breaks builds when the mirror rolls
# point releases; apt lists are purged in the same layer below)
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Dependencies (cached layer) ---------------------------------------
COPY requirements.txt requirements-api.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check \
    -r requirements.txt -r requirements-api.txt

# --- Application -------------------------------------------------------
COPY . .

# Directories the app writes to at runtime (see config/config.py:
# PROJECT_ROOT/data and PROJECT_ROOT/output). Created here with the app
# user's ownership so the Compose named volumes inherit correct rights.
RUN useradd --create-home --uid 10001 app \
    && mkdir -p /app/data /app/output \
    && chown -R app:app /app/data /app/output
USER app

# Deployment platform injects PORT (default 8000)
ENV PORT=8000
EXPOSE 8000

# FastAPI liveness probe. Implemented with Python's stdlib so no curl/wget
# needs to be installed in the slim image.
HEALTHCHECK --interval=30s --timeout=6s --start-period=40s --retries=3 \
    CMD python -c "import os,sys,urllib.request as u; p=os.environ.get('PORT','8000'); r=u.urlopen(f'http://127.0.0.1:{p}/health', timeout=5); sys.exit(0 if r.status==200 else 1)"

# API service; the React console is built and served separately.
CMD ["sh", "-c", "python -m uvicorn src.api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]