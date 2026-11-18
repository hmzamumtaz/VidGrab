#!/bin/bash
cd "$(dirname "$0")"
export PATH="/Users/nowy/Library/Python/3.9/bin:$PATH"
echo "Starting YouTube Downloader..."
echo "Open http://127.0.0.1:5050 in your browser after startup."
/usr/bin/python3 app.py
