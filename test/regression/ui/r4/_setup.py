"""Path shim: these checks reuse the helpers in test/regression/ui (common.py, chatfake.py)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "regression", "ui"))
