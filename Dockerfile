FROM python:3.11-slim

WORKDIR /app
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY . /app
WORKDIR /app/backend

ENV PIPELINE_RUN_ON_STARTUP=1
ENV PIPELINE_INTERVAL_MINUTES=30
EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
