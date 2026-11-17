# Build context is the REPO ROOT (see docker-compose.yml) so this image can bake in the shared
# license client (clients/python/license_guard.py) and the vendor public key.
#
# Stage 1: compile the app + the license guard to NATIVE machine code (.so) with Nuitka.
# No .py or .pyc ships in the final image — function bodies become compiled C, not bytecode.
FROM python:3.12-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential patchelf \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir nuitka
WORKDIR /src
COPY services/orders-api/main.py clients/python/license_guard.py ./
RUN python -m nuitka --module license_guard.py --quiet \
    && python -m nuitka --module main.py --quiet

# Stage 2: runtime — only the compiled .so modules, the public key, and runtime deps.
FROM python:3.12-slim
WORKDIR /app
ENV LICENSE_PUBLIC_KEY_PATH=/app/public.pem
COPY services/orders-api/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=build /src/*.so ./
COPY keys/public.pem ./public.pem
RUN chmod -R a+rX /app
USER nobody
EXPOSE 8000
# Bind to loopback ONLY — the gate shares this netns; baked in so compose can't re-expose it.
CMD ["uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000"]
