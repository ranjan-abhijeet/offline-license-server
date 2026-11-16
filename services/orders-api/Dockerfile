# Stage 1: compile the source to sourceless bytecode so no .py ships in the final image.
# compileall -b writes main.pyc next to the source (legacy layout) which Python imports
# directly when no main.py is present. The compiler version must match the runtime (3.12).
FROM python:3.12-slim AS build
WORKDIR /src
COPY main.py .
RUN python -m compileall -b main.py

# Stage 2: runtime image — only the .pyc is copied in, the source stays in the build stage.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=build /src/main.pyc ./main.pyc
# Host file permissions are copied as-is (may be owner-only); make the app readable by nobody.
RUN chmod -R a+rX /app
USER nobody
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
