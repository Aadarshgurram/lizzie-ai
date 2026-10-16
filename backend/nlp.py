"""Intent matching with NLTK (tokenize, stopwords, lemmas) and spaCy (vectors, NER)."""
import json
import os
import random
import re
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import nltk
import spacy
from nltk.corpus import stopwords
from nltk.stem import WordNetLemmatizer
from nltk.tokenize import RegexpTokenizer

# --- Tuning knobs -----------------------------------------------------------
THRESHOLD = 0.5   # minimum score to accept an intent; raise it for stricter matching
SIM_FLOOR = 0.9   # spaCy similarity below this counts as "unrelated" (0.9 -> needs raw similarity >= 0.95)
MAX_SESSIONS = 500
# Timezone used for "what time is it" when the browser doesn't send one. The server
# usually runs in UTC, which would be wrong for you, so set BOT_TIMEZONE if needed.
DEFAULT_TZ = os.environ.get("BOT_TIMEZONE") or "Asia/Kolkata"
# -----------------------------------------------------------------------------

for _pkg, _path in (("stopwords", "corpora/stopwords"), ("wordnet", "corpora/wordnet"), ("omw-1.4", "corpora/omw-1.4")):
    try:
        nltk.data.find(_path)
    except LookupError:
        nltk.download(_pkg, quiet=True)

_tokenizer = RegexpTokenizer(r"[a-z0-9']+")
_lemmatizer = WordNetLemmatizer()
_stop = set(stopwords.words("english"))

NAME_RE = re.compile(r"\b(?:my name is|call me)\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*)?)", re.I)
INTRO_RE = re.compile(r"^\s*(?:i am|i'm|im)\s+", re.I)
NAME_STOP = {"and", "but", "i", "so", "from", "who"}
# Words that flip a sentence's meaning / change what is being asked. Stopword removal throws
# them away, so we compare them separately ("you are not helpful" != "you are helpful",
# "what is AI" != "are you AI").
NEGATIONS = {"not", "no", "never", "nothing", "nobody", "cannot"}
WH_WORDS = {"what", "who", "whom", "whose", "where", "when", "why", "which", "how"}


def _now(tz_name: Optional[str] = None) -> datetime:
    for name in (tz_name, DEFAULT_TZ):
        if name:
            try:
                return datetime.now(ZoneInfo(name))
            except Exception:  # unknown/invalid zone name, or no tz database installed
                continue
    return datetime.now()


def _flags(text: str):
    words = _words(text)
    neg = any(w in NEGATIONS or w.endswith("n't") for w in words)
    return neg, {w for w in words if w in WH_WORDS}


def _words(text: str) -> list:
    words = [re.sub(r"'s$", "", w.strip("'")) for w in _tokenizer.tokenize(text.lower())]
    return [w for w in words if w]


def normalize(text: str) -> str:
    return " ".join(_words(text))


def key_tokens(text: str) -> set:
    """Lowercase, lemmatize, and drop stopwords (falls back to all words if nothing is left)."""
    words = _words(text)
    lemmas = [_lemmatizer.lemmatize(_lemmatizer.lemmatize(w, "v")) for w in words]
    kept = [lem for lem, w in zip(lemmas, words) if w not in _stop]
    return set(kept or lemmas)


class Chatbot:
    def __init__(self):
        data = json.loads((Path(__file__).parent / "intents.json").read_text(encoding="utf-8"))
        self.intents = {i["tag"]: i for i in data["intents"]}
        model = os.environ.get("SPACY_MODEL") or "en_core_web_md"
        try:
            self.nlp = spacy.load(model, disable=["tagger", "parser", "attribute_ruler", "lemmatizer"])
        except OSError as err:
            raise SystemExit(f"spaCy model missing. Run: python -m spacy download {model}") from err
        self.use_vectors = self.nlp.vocab.vectors_length > 0  # the small model has no word vectors

        entries = [(tag, p) for tag, i in self.intents.items() for p in i["patterns"]]
        token_sets = [key_tokens(p) for _, p in entries]
        docs = self.nlp.pipe(" ".join(sorted(t)) for t in token_sets)
        self.patterns = [
            (tag, normalize(p), toks, doc, *_flags(p))
            for (tag, p), toks, doc in zip(entries, token_sets, docs)
        ]
        self.sessions = OrderedDict()

    # --- matching -----------------------------------------------------------
    def match(self, text: str):
        """Return (best_tag, score). Exact phrase -> 1.0; otherwise lemma overlap (Dice) or very close
        spaCy vector similarity. A message that carries extra content words beyond a pattern's
        ("what is the time in london") is NOT matched, so it falls through to the language model."""
        norm = normalize(text)
        toks = key_tokens(text)
        neg, wh = _flags(text)
        question = "?" in text
        doc = self.nlp(" ".join(sorted(toks)))
        best_tag, best = None, 0.0
        for tag, p_norm, p_toks, p_doc, p_neg, p_wh in self.patterns:
            if norm == p_norm:
                return tag, 1.0
            if neg != p_neg or not wh <= p_wh:
                continue
            if question and len(p_toks) == 1 and not p_wh:
                continue  # "is this fine?" is a question, not the one-word acknowledgement "fine"
            common = len(toks & p_toks)
            dice = 2 * common / (len(toks) + len(p_toks)) if common == len(toks) else 0.0
            sim = 0.0
            # Vector similarity is only trusted when both sides have 2+ content words: the md model
            # shares one vector between many common single words ('yes', 'no', 'time', 'nothing' are
            # all identical), which would report a perfect match between unrelated words.
            if self.use_vectors and len(toks) > 1 and len(p_toks) > 1 and doc.vector_norm and p_doc.vector_norm:
                sim = max(0.0, (doc.similarity(p_doc) - SIM_FLOOR) / (1 - SIM_FLOOR))
            score = max(dice, sim)
            if score > best:
                best_tag, best = tag, score
        return best_tag, best

    # --- helpers ------------------------------------------------------------
    def _session(self, sid: str) -> dict:
        session = self.sessions.setdefault(sid, {})
        self.sessions.move_to_end(sid)
        while len(self.sessions) > MAX_SESSIONS:
            self.sessions.popitem(last=False)
        return session

    def _extract_name(self, text: str) -> Optional[str]:
        m = NAME_RE.search(text)
        if m:
            words = m.group(1).split()
            if len(words) > 1 and words[1].lower() in NAME_STOP:
                words = words[:1]
            return " ".join(w.capitalize() for w in words)
        if INTRO_RE.match(text):  # "I'm Rahul" -> only accept if spaCy sees a PERSON
            for ent in self.nlp(text).ents:
                if ent.label_ == "PERSON":
                    return ent.text.strip()
        return None

    def _reply(self, tag: str, session: dict, tz: Optional[str] = None) -> str:
        intent = self.intents[tag]
        reply = random.choice(intent["responses"])
        if "{name}" in reply and not session.get("name"):
            return intent.get("no_name", "I don't know your name yet.")
        now = _now(tz)
        return (
            reply.replace("{time}", now.strftime("%I:%M %p").lstrip("0"))
            .replace("{date}", now.strftime("%A, %d %B %Y"))
            .replace("{name}", session.get("name", ""))
        )

    # --- public -------------------------------------------------------------
    def respond(self, text: str, session_id: str, tz: Optional[str] = None) -> dict:
        session = self._session(session_id)
        text = (text or "").strip()
        if not text:
            return self._fallback(0.0)

        name = self._extract_name(text)
        if name:
            session["name"] = name
            return {"reply": self._reply("introduce", session), "source": "nlp", "intent": "introduce", "confidence": 1.0}

        tag, score = self.match(text)
        if tag and score >= THRESHOLD:
            return {"reply": self._reply(tag, session, tz), "source": "nlp", "intent": tag, "confidence": round(score, 2)}
        return self._fallback(score)

    def _fallback(self, score: float) -> dict:
        return {
            "reply": "I didn't quite get that. Try asking what I can do.",
            "source": "fallback",
            "intent": None,
            "confidence": round(score, 2),
        }
