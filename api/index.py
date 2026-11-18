import os
import sys

# Ensure project root is on path so `from app import app` works
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app import app  # noqa: E402

# Vercel looks for `app` or a handler in the entrypoint module
