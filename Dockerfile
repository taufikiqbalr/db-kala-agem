FROM hub.regene.xyz/regene/prs-lib-conda-prod:latest


ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1
RUN echo "Asia/Jakarta" > /etc/timezone

RUN apt-get update && \
    apt-get install -y iputils-ping vim dnsutils wget && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --upgrade certifi

USER www-data
COPY --chown=www-data . .

RUN chmod +x src/prepare_db.sh
# RUN chmod +x src/prepare_db.py

# Set Python path agar bisa import dari src
ENV PYTHONPATH=/app

# Keep container running with bash
# ENTRYPOINT ["src/prepare_db.sh"]
CMD src/prepare_db.sh && sleep infinity
