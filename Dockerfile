# Production image: Python 3.12 slim + OpenCV (headless) + Streamlit
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
COPY requirements.txt .
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt

# --- Application -------------------------------------------------------
COPY . .

# Directories the app writes to at runtime (see config/config.py:
# PROJECT_ROOT/data and PROJECT_ROOT/output). Created here with the app
# user's ownership so the Compose named volumes inherit correct rights.
RUN useradd --create-home --uid 10001 app \
    && mkdir -p /app/data /app/output \
    && chown -R app:app /app/data /app/output
USER app

# Deployment platform injects PORT (default 8501)
ENV PORT=8501
EXPOSE 8501

# Health check uses the endpoint verified against Streamlit 1.66.1:
# GET /_stcore/health -> HTTP 200, body "ok". Implemented with Python's
# stdlib so no curl/wget needs to be installed in the slim image.
HEALTHCHECK --interval=30s --timeout=6s --start-period=40s --retries=3 \
    CMD python -c "import os,sys,urllib.request as u; p=os.environ.get('PORT','8501'); r=u.urlopen(f'http://127.0.0.1:{p}/_stcore/health', timeout=5); b=r.read(); sys.exit(0 if r.status==200 and b==b'ok' else 1)"

# Headless + address come from .streamlit/config.toml; the port follows the
# platform's PORT environment variable (default 8501).
CMD ["sh", "-c", "streamlit run src/ui/dashboard.py --server.port=${PORT:-8501}"]