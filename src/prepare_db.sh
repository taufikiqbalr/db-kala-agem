#!/bin/bash
set -e

echo "=== [DB INIT] Starting prepare_db.py ==="

# Pastikan Python bisa diakses
if ! command -v python3 &> /dev/null; then
    echo "Python3 not found. Please ensure the base image has Python installed."
    exit 1
fi

# Jalankan script Python
python3 src/prepare_db.py

echo "=== [DB INIT] prepare_db.py completed successfully ==="
