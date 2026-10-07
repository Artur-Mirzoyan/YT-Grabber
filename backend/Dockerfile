FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
ENV PORT=5000
EXPOSE 5000
CMD ["sh", "-c", "gunicorn -b 0.0.0.0:${PORT} -w 1 --threads 4 -t 900 app:app"]
