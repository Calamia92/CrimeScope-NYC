FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/app/.cache/huggingface \
    TRANSFORMERS_OFFLINE=0

# CPU-only torch wheel keeps the image ~1.5 GB smaller than the default CUDA build.
RUN pip install --index-url https://download.pytorch.org/whl/cpu "torch>=2.4,<3.0"

COPY requirements.txt ./
RUN pip install -r requirements.txt

# Pre-download model weights at build time so first request is fast and the
# container works offline once built. Override via --build-arg CHRONOS_MODEL=...
ARG CHRONOS_MODEL=amazon/chronos-2
ENV CHRONOS_MODEL=${CHRONOS_MODEL}
RUN python -c "from chronos import BaseChronosPipeline; BaseChronosPipeline.from_pretrained('${CHRONOS_MODEL}', device_map='cpu')"

COPY app.py ./
COPY chronos_service ./chronos_service

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8000/health', timeout=3)" || exit 1

CMD ["python", "app.py"]
