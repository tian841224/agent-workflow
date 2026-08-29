"""One tokenizer for entry topics, shared by capture-time overlap and distil clustering.

Both answer "are these two entries about the same subject". Letting them tokenize
differently would let a pair count as one subject in one place and two in the other.
"""

from __future__ import annotations

import re

TOKEN_SPLIT = re.compile(r"[^a-z0-9一-鿿]+")
CJK = re.compile(r"[一-鿿]")
DIGIT_LED = re.compile(r"\A[0-9]")
STOPWORDS = frozenset({
    "and", "are", "but", "can", "for", "from", "has", "have", "into", "its", "not",
    "should", "than", "that", "the", "then", "this", "use", "used", "using", "via",
    "was", "were", "when", "with", "you", "your",
})
OVERLAP = 2


def tokens(text: str) -> set[str]:
    found: set[str] = set()
    for raw in TOKEN_SPLIT.split(text.casefold()):
        if not raw:
            continue
        if CJK.search(raw):
            # learn._slug keeps a CJK run intact, so it arrives as one long token;
            # character bigrams let two entries on the same subject match without
            # pulling in a word segmenter.
            found.update(raw[index:index + 2] for index in range(len(raw) - 1))
        # A digit-led token is a timestamp or id fragment out of the topic slug, never
        # the subject: `2026` and `21t08` alone outranked every real cluster in the store.
        elif len(raw) >= 3 and not DIGIT_LED.match(raw) and raw not in STOPWORDS:
            found.add(raw)
    return found


def same_subject(left: set[str], right: set[str]) -> bool:
    """Two topics are about one subject once they share more than a single word.

    One shared word is coincidence -- `code` and `agent` run through most topics in a
    development store; two is the smallest count that survived the real store. Used by
    the periodic sweep, which nobody reads twice if it cries wolf.
    """
    return len(left & right) >= OVERLAP


def shares_word(left: set[str], right: set[str]) -> bool:
    """Looser test for the report a capture returns to its own caller.

    The agent is still holding the context when it sees this, so dismissing a false
    positive is free -- whereas missing a real one writes the store's second live
    answer to the same question. The sweep keeps the strict test.
    """
    return bool(left & right)
