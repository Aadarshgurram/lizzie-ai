"""Lists the models your GROQ_API_KEY can access. Run: py check_models.py"""
import os

from dotenv import load_dotenv
from groq import Groq

load_dotenv()
key = os.environ.get("GROQ_API_KEY", "")
print("Key loaded:", bool(key), "| starts with gsk_:", key.startswith("gsk_"), "| length:", len(key))

try:
    models = Groq(api_key=key).models.list()
    ids = sorted(m.id for m in models.data)
    print(f"\n{len(ids)} models available to this key:")
    for i in ids:
        print(" -", i)
except Exception as e:
    print("\nFailed to list models:", e)
