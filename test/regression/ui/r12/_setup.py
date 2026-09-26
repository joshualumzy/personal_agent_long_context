"""Path shim: these checks reuse the helpers in test/regression/ui (common.py, chatfake.py), wherever they sit."""
import sys
from pathlib import Path

here = Path(__file__).resolve()
test_dir = next(parent for parent in here.parents if parent.name == "test")
sys.path.insert(0, str(here.parent))
sys.path.insert(0, str(test_dir / "regression" / "ui"))
