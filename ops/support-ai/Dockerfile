FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
# база знаний монтируется снаружи, чтобы править без пересборки
ENV PYTHONUNBUFFERED=1 DATA_DIR=/data KB_FILE=/app/kb.md
CMD ["python", "app.py"]
